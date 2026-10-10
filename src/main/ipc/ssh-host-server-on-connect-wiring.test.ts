import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { OrcadHostUnsupportedError } from '../ssh/orcad-host-unavailable'
import { allowsDirectSshRelay, SshConnectionStore } from '../ssh/ssh-connection-store'
import { resolveHostServerOnConnect } from '../ssh/ssh-host-server-on-connect'

const mocks = vi.hoisted(() => {
  const registry: { current: unknown } = { current: null }
  return {
    registry,
    deploy: vi.fn(),
    convert: vi.fn(),
    tunnel: vi.fn(async () => undefined),
    broadcast: vi.fn()
  }
})
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.5.0', getPath: () => '/tmp/unused' })
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => mocks.registry.current,
  hasRegisteredDirectSshAuthority: () => false
}))
vi.mock('../ssh/orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('../ssh/orcad-runtime-conversion', () => ({
  convertSshTargetToManagedOrcad: mocks.convert
}))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.tunnel }))
vi.mock('../ssh/orcad-artifact-materializer', () => ({ hasOrcadTemplate: () => true }))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastSshState: mocks.broadcast }))
vi.mock('./ssh-ipc-context', () => ({ getCurrentMainWindow: () => null }))
vi.mock('./ssh-session-teardown', () => ({ disconnectRegisteredSshTarget: vi.fn() }))

const { hostServerOnConnectDeps } = await import('./ssh-host-server-on-connect-wiring')
const { connectInFlight } = await import('./ssh-connect-attempt-registry')
const { getSshHostServerStatus } = await import('../ssh/ssh-host-server-status')

const TARGET: SshTarget = {
  id: 'ssh-box',
  label: 'Box',
  host: 'box.example.com',
  port: 22,
  username: 'me',
  generation: 3
}

let userDataPath: string
let store: Store

beforeEach(() => {
  vi.clearAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'host-server-wiring-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.registry.current = new SshConnectionStore(store as never)
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const target = (): SshTarget => store.getSshTarget(TARGET.id)!

describe('connect-time server decision against the real profile', () => {
  it('releases an empty host claim when orcad cannot run, records why, and keeps the relay', async () => {
    mocks.deploy.mockImplementation(async () => {
      // The real deploy claims the host before it finds the template missing the target.
      store.updateSshTarget(TARGET.id, {
        orcadFence: { environmentId: 'env-new' },
        orcadProvisioning: { requestId: 'env-new', name: 'Box' }
      })
      throw new OrcadHostUnsupportedError('Packaged orcad template does not support x')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(
      resolveHostServerOnConnect(target(), hostServerOnConnectDeps(userDataPath))
    ).resolves.toEqual({ route: 'relay', reason: 'orcad_unavailable', detail: 'unsupported_host' })
    warn.mockRestore()
    expect(target().orcadFence).toBeUndefined()
    expect(target().managedServerUnavailable).toEqual({
      reason: 'unsupported_host',
      appVersion: '1.5.0'
    })
    expect(allowsDirectSshRelay(target())).toBe(true)

    // Not retried on the next connect of the same build.
    mocks.deploy.mockClear()
    await resolveHostServerOnConnect(target(), hostServerOnConnectDeps(userDataPath))
    expect(mocks.deploy).not.toHaveBeenCalled()
  })

  it('retries a host an older build kept on the relay', async () => {
    const deps = hostServerOnConnectDeps(userDataPath)
    store.updateSshTarget(TARGET.id, {
      managedServerUnavailable: { reason: 'unsupported_host', appVersion: '1.4.0' }
    })
    expect(deps.recordedUnavailable(target())).toBeNull()
  })

  it('refuses while a saved relay terminal is unproven, without converting', async () => {
    store.addRepo({
      id: 'repo-1',
      path: '/srv/app',
      displayName: 'App',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git',
      connectionId: TARGET.id
    })
    store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'pty-1', state: 'expired' })
    await expect(
      resolveHostServerOnConnect(target(), hostServerOnConnectDeps(userDataPath))
    ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_unverifiable', terminals: 0 })
    expect(mocks.convert).not.toHaveBeenCalled()
  })

  it('drops progress from a decision whose connect was cancelled', () => {
    const deps = hostServerOnConnectDeps(userDataPath)
    deps.progress(target(), 'deploying')
    expect(getSshHostServerStatus(TARGET.id)).toBeUndefined()
    expect(mocks.broadcast).not.toHaveBeenCalled()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: progress reads only presence.
    connectInFlight.set(TARGET.id, {} as never)
    try {
      deps.progress(target(), 'deploying')
      expect(getSshHostServerStatus(TARGET.id)).toEqual({ kind: 'setting-up', phase: 'deploying' })
      expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    } finally {
      connectInFlight.delete(TARGET.id)
    }
  })
})
