import { afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted((): { channel: string; payload: unknown }[] => [])
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload })
        }
      }
    ]
  },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
vi.mock('../wsl/wsl-host-connector', () => ({ createWslHostConnector: vi.fn() }))
vi.mock('../wsl/wsl-host-e2e-fake-connector', () => ({
  createFakeWslHostConnector: vi.fn(),
  readFakeWslHostsConfig: () => null
}))
vi.mock('../orcad/orcad-artifact-materializer', () => ({ hasOrcadTemplate: () => true }))
vi.mock('./runtime-environments/runtime-environment-removal-cleanup', () => ({
  retireRemovedRuntimeEnvironment: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-request-connections', () => ({
  isRemoteRuntimeConnectionReady: () => false
}))
vi.mock('../ssh/orcad-terminal-census-client', () => ({ requestOrcadTerminalCensus: vi.fn() }))
const service = vi.hoisted(() => ({
  add: vi.fn(
    async (): Promise<{
      ok: boolean
      environmentId?: string
      kind?: string
      message?: string
    }> => ({
      ok: true,
      environmentId: 'wsl:Ubuntu'
    })
  ),
  remove: vi.fn(async () => ({ stopped: true })),
  hasServerFiles: vi.fn(() => true),
  recordForEnvironment: vi.fn(() => ({ distro: 'Ubuntu', environmentId: 'wsl:Ubuntu' }))
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => service,
  setWslHostService: vi.fn()
}))

import { registerWslHostHandlers } from './wsl-host-handlers'
import {
  configureWslHostsGate,
  noteWslHostsLivePolicyBlock,
  resetWslHostsGateForTests,
  wslHostsServing
} from '../wsl/wsl-host-gate'
import { WSL_HOST_CAPABILITY_CHANNEL } from '../../shared/wsl-host-types'
import { onWslHostUserAction, type WslHostUserAction } from '../wsl/wsl-host-user-actions'

function register(): void {
  registerWslHostHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the add and remove handlers run, and they read the active runtime setting alone.
    store: { getSettings: () => ({ activeRuntimeEnvironmentId: null }) } as never,
    getUserDataPath: () => '/user-data',
    invalidateTransport: vi.fn()
  })
}

describe('WSL host IPC: the user Add and Remove (D3a)', () => {
  // Removes are reported by the host service itself (see wsl-host-service.test.ts), so both the
  // sidebar and Settings paths count; here the service is mocked and only the Add is the IPC's.
  afterEach(() => {
    vi.unstubAllEnvs()
    service.add.mockClear()
  })

  it('reports a successful Add, never a failed one', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    register()
    const heard: WslHostUserAction[] = []
    const stop = onWslHostUserAction((action) => heard.push(action))
    await handlers.get('wslHosts:remove')?.({}, { environmentId: 'wsl:Ubuntu' })
    await handlers.get('wslHosts:add')?.({}, { distro: 'Ubuntu' })
    service.add.mockResolvedValueOnce({ ok: false, kind: 'failed', message: 'no' })
    await handlers.get('wslHosts:add')?.({}, { distro: 'Debian' })
    stop()
    expect(heard).toEqual([{ kind: 'added', distro: 'Ubuntu' }])
  })

  it('refuses an Add in serve-only and says so in its capability, keeping saved hosts usable', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', undefined)
    register()

    expect(await handlers.get('wslHosts:add')?.({}, { distro: 'Ubuntu' })).toMatchObject({
      ok: false,
      kind: 'disabled'
    })
    expect(service.add).not.toHaveBeenCalled()
    expect(await handlers.get('wslHosts:getCapability')?.({})).toMatchObject({
      acceptsNewWork: false
    })
    await handlers.get('wslHosts:remove')?.({}, { environmentId: 'wsl:Ubuntu' })
    expect(service.remove).toHaveBeenCalledWith('wsl:Ubuntu')
  })

  it('under a remote policy block, refuses an Add but keeps Remove', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    configureWslHostsGate({
      hasSavedWslHost: () => true,
      hasWslMoveCutover: () => false,
      policy: () => 'block'
    })
    try {
      register()

      expect(await handlers.get('wslHosts:add')?.({}, { distro: 'Ubuntu' })).toMatchObject({
        ok: false,
        kind: 'disabled'
      })
      expect(service.add).not.toHaveBeenCalled()
      service.remove.mockClear()
      await handlers.get('wslHosts:remove')?.({}, { environmentId: 'wsl:Ubuntu' })
      expect(service.remove).toHaveBeenCalledWith('wsl:Ubuntu')
    } finally {
      resetWslHostsGateForTests()
    }
  })

  // A block published while Orca runs must stop new hosts now, not at the next launch.
  it('a live policy block refuses an Add at once, tells the window, and keeps the saved host served', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    configureWslHostsGate({ hasSavedWslHost: () => true, hasWslMoveCutover: () => false })
    try {
      register()
      expect(await handlers.get('wslHosts:getCapability')?.({})).toMatchObject({
        acceptsNewWork: true
      })
      sent.length = 0

      noteWslHostsLivePolicyBlock()

      expect(sent).toEqual([
        {
          channel: WSL_HOST_CAPABILITY_CHANNEL,
          payload: { serverFiles: true, acceptsNewWork: false }
        }
      ])
      expect(await handlers.get('wslHosts:add')?.({}, { distro: 'Debian' })).toMatchObject({
        ok: false,
        kind: 'disabled'
      })
      expect(service.add).not.toHaveBeenCalled()
      expect(wslHostsServing()).toBe(true)
      service.remove.mockClear()
      await handlers.get('wslHosts:remove')?.({}, { environmentId: 'wsl:Ubuntu' })
      expect(service.remove).toHaveBeenCalledWith('wsl:Ubuntu')
    } finally {
      resetWslHostsGateForTests()
    }
  })
})
