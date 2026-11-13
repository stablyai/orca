import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
// #34089 for VMs reached as paired Orca servers: a VM its provider stopped or reclaimed stays
// recorded as running. Once Orca's own probes have failed for minutes, opening the workspace runs
// the recipe's resume and keeps the device pairing unless the server came back with a new host key.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockState = {
  desktopDataPath: string
  record: Record<string, unknown>
  recipe: Record<string, unknown>
  sharedControlState: string | undefined
}

const state = vi.hoisted((): MockState => ({
  desktopDataPath: '',
  record: {},
  recipe: { resume: './resume.sh' },
  sharedControlState: undefined
}))
const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  invalidateTransport: vi.fn(),
  reconnectControl: vi.fn(),
  refreshStatus: vi.fn(async () => ({})),
  updateStatus: vi.fn((_userDataPath: string, _id: string, patch: Record<string, unknown>) => patch)
}))

vi.mock('electron', () => ({ app: { getPath: () => state.desktopDataPath } }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  updateEphemeralVmRuntimeStatus: mocks.updateStatus
}))
vi.mock('../../shared/ephemeral-vm-workspace-runtime', () => ({
  findWorkspaceEphemeralVmRuntime: () => state.record
}))
vi.mock('../ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: () => ({ repoPath: '/repo', recipe: state.recipe })
}))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: mocks.invalidateTransport
}))
vi.mock('../ipc/runtime-environments/connections/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({ refresh: mocks.refreshStatus }),
  reconnectRemoteRuntimeSharedControlConnection: mocks.reconnectControl,
  getRemoteRuntimeSharedControlDiagnostics: () =>
    state.sharedControlState ? { state: state.sharedControlState } : null
}))
vi.mock('../ssh/targets/ssh-target-registry', () => ({ getRegisteredSshState: () => undefined }))
vi.mock('./runtime-service', () => ({ resumeEphemeralVmRuntime: mocks.resume }))
vi.mock('./runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  refreshRuntimeOwnedSshTarget: vi.fn()
}))

import type { Store } from '../persistence/loading-store/store'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { generateKeyPair } from '../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { runtimeHostStatusError } from '../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import { DeviceRegistry } from '../runtime/rpc/server/pairing/device-registry'
import {
  clearRuntimeEnvironmentContactLoss,
  isRuntimeEnvironmentContactLost,
  noteRuntimeEnvironmentStatusContact,
  RUNTIME_CONTACT_LOST_AFTER_MS
} from '../ipc/runtime-environments/status/runtime-environment-contact-loss'
import { clearRuntimeEnvironmentManualDisconnect } from '../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { resumeEphemeralVmWorkspace } from './workspace-resume'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe context reader is mocked, so the resume never reads this store.
const STORE = {} as Store
const REQUEST = { sshHeld: false, sshUserDisconnects: 0 }
type KeyPair = ReturnType<typeof generateKeyPair>

/** A fake orcad: a real encrypted server with a host key and a device list that survive a reboot. */
async function bootOrcad(serverDataPath: string, keyPair: KeyPair) {
  const registry = (): DeviceRegistry => new DeviceRegistry(serverDataPath)
  const server = await createSharedControlTestServer({
    keyPair,
    deviceToken: registry().getOrCreatePendingDevice('CLI', 'runtime').token,
    authorize: (auth) => {
      const token =
        typeof auth === 'object' && auth !== null && 'deviceToken' in auth ? auth.deviceToken : null
      return typeof token === 'string' && registry().validateToken(token) !== null
    },
    resultForRequest: () => ({ runtimeId: 'vm-runtime' })
  })
  return { pairingCode: encodePairingOffer(server.offer) }
}

/** The desktop's own status probe of the environment's saved pairing, as its status owner sends it. */
async function probe(environmentId: string) {
  const connection = getPreferredPairedRuntimeConnection(
    await resolveEnvironment(state.desktopDataPath, environmentId)
  )
  try {
    const response = await sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
      connection,
      'status.get',
      undefined,
      2_000,
      undefined,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      undefined,
      undefined
    )
    noteRuntimeEnvironmentStatusContact(environmentId, response)
    return response
  } catch (error) {
    const failure = runtimeHostStatusError(error)
    noteRuntimeEnvironmentStatusContact(environmentId, failure)
    return failure
  }
}

describe('opening a workspace whose paired VM server Orca could not reach for minutes', () => {
  let serverDataPath: string
  let environmentId: string
  let keyPair: KeyPair
  let now: number

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    now = Date.parse('2026-11-08T12:00:00Z')
    vi.setSystemTime(now)
    state.desktopDataPath = mkdtempSync(join(tmpdir(), 'orca-lost-vm-desktop-'))
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-lost-vm-server-'))
    keyPair = generateKeyPair()
    const boot = await bootOrcad(serverDataPath, keyPair)
    environmentId = (
      await addEnvironmentFromPairingCode(state.desktopDataPath, {
        name: 'VM workspace',
        pairingCode: boot.pairingCode,
        source: 'ephemeral-vm'
      })
    ).id
    state.record = {
      id: 'vm-1',
      status: 'running',
      connectionMode: 'orca-server',
      runtimeEnvironmentId: environmentId
    }
    expect((await probe(environmentId)).ok).toBe(true)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await closeSharedControlTestServers()
    clearRuntimeEnvironmentContactLoss(environmentId)
    clearRuntimeEnvironmentManualDisconnect(environmentId)
    state.recipe = { resume: './resume.sh' }
    state.sharedControlState = undefined
    mocks.resume.mockReset()
    mocks.invalidateTransport.mockClear()
    mocks.reconnectControl.mockClear()
    mocks.refreshStatus.mockClear()
    mocks.updateStatus.mockClear()
    await removeTempDirs([state.desktopDataPath, serverDataPath])
  })

  /** The VM goes away; Orca's probes keep failing for `forMs`. */
  async function vmDisappears(forMs: number): Promise<void> {
    await closeSharedControlTestServers()
    for (let elapsed = 0; elapsed <= forMs; elapsed += forMs / 3) {
      vi.setSystemTime(now + elapsed)
      const failed = await probe(environmentId)
      expect(failed).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    }
  }

  /** The recipe's resume boots the VM again on a new address, printing a fresh pairing code. */
  function resumeBoots(nextKeyPair: KeyPair, nextServerDataPath = serverDataPath): void {
    mocks.resume.mockImplementation(async () => {
      const boot = await bootOrcad(nextServerDataPath, nextKeyPair)
      return {
        ok: true,
        skipped: false,
        runtime: {
          id: 'vm-1',
          status: 'running',
          recipeResult: {
            connection: { type: 'orca-server', pairingCode: boot.pairingCode, projectRoot: '/w' }
          }
        }
      }
    })
  }

  it('resumes the VM and keeps the pairing when it comes back with the same host key', async () => {
    await vmDisappears(RUNTIME_CONTACT_LOST_AFTER_MS)
    expect(isRuntimeEnvironmentContactLost(environmentId)).toBe(true)
    resumeBoots(keyPair)

    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)

    expect(isRuntimeEnvironmentContactLost(environmentId)).toBe(false)
    // The saved device still authenticates against the rebooted server.
    expect((await probe(environmentId)).ok).toBe(true)
  })

  it('re-pairs from the fresh code when the VM comes back with a different host key', async () => {
    await vmDisappears(RUNTIME_CONTACT_LOST_AFTER_MS)
    const rebuiltServerDataPath = mkdtempSync(join(tmpdir(), 'orca-lost-vm-rebuilt-'))
    const rotated = generateKeyPair()
    resumeBoots(rotated, rebuiltServerDataPath)

    try {
      await resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)

      expect((await probe(environmentId)).ok).toBe(true)
    } finally {
      await removeTempDirs([rebuiltServerDataPath])
    }
  })
})
