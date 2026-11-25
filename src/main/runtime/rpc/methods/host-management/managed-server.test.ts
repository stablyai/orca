import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addManagedOrcadEnvironment } from '../../../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-operations'
import type { OrcadTerminalCensus } from '../../../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import { encodePairingOffer } from '../../../../../shared/remote-runtime/pairing/pairing'
import {
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/host-runtime-capabilities'
import { createManagedOrcadActions } from '../../../../ipc/runtime-environments/managed-orcad/managed-orcad-actions'
import { emptyOrcadActivationRecord } from '../../../../managed-server/activation/orcad-activation-record'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../../../../managed-server/activation/orcad-daemon-protocol-crossing'
import { planOrcadUpdate } from '../../../../managed-server/activation/orcad-update-plan'
import type { OrcadDeployOptions } from '../../../../managed-server/install/orcad-remote-deploy'
import * as managedRuntimeContext from '../../../../managed-server/lifecycle/orcad-managed-runtime-context'
import { clearManagedOrcadUpdateDeferral } from '../../../../managed-server/lifecycle/orcad-managed-update-deferrals'
import { getRemoteHostPlatform } from '../../../../ssh/remote-host/ssh-remote-platform'
import { registerManagedServerActions } from '../../../hosts/management/managed-server-actions-registry'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { MANAGED_SERVER_METHODS } from './managed-server'

vi.mock('../../../../managed-server/lifecycle/orcad-terminal-census-client', () => ({
  collectManagedTerminalCensus: async () => UNCOUNTED
}))

vi.mock('../../../../orcad/artifact-slots/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/bundle'
}))

vi.mock('../../../../managed-server/lifecycle/orcad-managed-version-gc', () => ({
  pruneSupersededOrcadCandidates: async () => {}
}))

vi.mock('../../../../managed-server/install/orcad-remote-deploy', () => ({
  deployOrcad: async ({ census, censusRecord, force }: OrcadDeployOptions) => {
    if (!censusRecord) {
      throw new Error('Missing incumbent activation record')
    }
    const plan = planOrcadUpdate({
      record: censusRecord,
      candidateVersion: 'v2',
      census,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      hostDaemonProtocols: [],
      force
    })
    if (plan.action === 'defer') {
      return { ...plan, outcome: 'installed-not-activated', fullVersion: 'v2' }
    }
    if (plan.action === 'proceed') {
      // Stop the fixture before it would replace the incumbent on a real host.
      throw ACTIVATION_AUTHORIZED
    }
    throw new Error('The fixture needs a newer candidate')
  }
}))

// What a released orcad answers when its daemon never started: no session or in-process count.
const UNCOUNTED: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null,
  answered: true
}

const MARKERS = [MANAGED_SERVER_RUNTIME_CAPABILITY, MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY]
const ACTIVATION_AUTHORIZED = new Error('Authorized activation over an uncounted census')
const ENVIRONMENT_ID = 'managed-force-test'

async function unexpectedRemoteOperation(): Promise<never> {
  throw new Error('The fixture must never execute commands or write files on the host')
}

describe('managedServer.update limited force', () => {
  let userDataPath: string
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-'))
    runtime = new OrcaRuntimeService()
    const target = {
      id: 'ssh-target',
      label: 'Build box',
      host: 'build-box.test',
      port: 22,
      username: 'orca'
    }
    vi.spyOn(managedRuntimeContext, 'resolveLinkedOrcadContext').mockResolvedValue({
      target,
      activationRecord: { ...emptyOrcadActivationRecord(), active: 'v1' },
      serverTarget: 'linux-x64-glibc',
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/orca',
      userDataDir: '/home/orca/.orca',
      connection: {
        getTarget: () => target,
        usesSystemSshTransport: () => false,
        getConnectGeneration: () => 1,
        exec: unexpectedRemoteOperation,
        uploadDirectory: unexpectedRemoteOperation,
        writeFile: unexpectedRemoteOperation
      }
    })
    addManagedOrcadEnvironment(userDataPath, {
      id: ENVIRONMENT_ID,
      name: 'build-box',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:41000/runtime',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
        deviceToken: 'fixture-token'
      }),
      orcadDeployment: {
        sshTargetId: target.id,
        sshTargetGeneration: 1,
        localPort: 41000,
        remotePort: 6768
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    registerManagedServerActions(null)
    clearManagedOrcadUpdateDeferral(ENVIRONMENT_ID)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function registerDesktop() {
    registerManagedServerActions(
      createManagedOrcadActions({
        getUserDataPath: () => userDataPath,
        getActiveEnvironmentId: () => null,
        invalidateTransport: () => {},
        clearHostServerNotes: () => {},
        clearHostServerStatus: () => {},
        store: {
          getRemoteLayoutSnapshotWorkspace: () => undefined,
          setRemoteLayoutSnapshotWorkspace: () => {},
          setRemoteLayoutSnapshot: () => {},
          setHostRepoCatalogSnapshot: () => {},
          removeWorkspaceSessionHost: () => {}
        }
      })
    )
  }

  function update(params: unknown) {
    const method = MANAGED_SERVER_METHODS.find(({ name }) => name === 'managedServer.update')
    if (!method) {
      throw new Error('Missing managedServer.update')
    }
    return method.handler(method.params.parse(params), { runtime, clientKind: 'runtime' })
  }

  it('advertises limited force and defers bare force over an uncounted census', async () => {
    for (const marker of MARKERS) {
      expect(runtime.getStatus().capabilities).not.toContain(marker)
    }
    registerDesktop()
    expect(runtime.getStatus().capabilities).toEqual(expect.arrayContaining(MARKERS))

    await expect(update({ selector: 'build-box', force: true })).resolves.toMatchObject({
      outcome: 'deferred',
      code: 'orcad_update_daemon_protocol_unverifiable',
      forceable: true
    })
  })

  it('authorizes activation over the same uncounted census when force includes confirmation', async () => {
    registerDesktop()

    await expect(
      update({ selector: 'build-box', force: true, endInProcessTerminals: true })
    ).rejects.toBe(ACTIVATION_AUTHORIZED)
  })
})
