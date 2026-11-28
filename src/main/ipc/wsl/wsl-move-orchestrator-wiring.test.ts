import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const triggers: [string, string][] = []
  const sent: [string, unknown][] = []
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    constructed: 0,
    triggers,
    sent,
    gateOpen: true
  }
})

const SIDECAR_RECORDS = [{ distro: 'Ubuntu', state: 'failed' }]
const MAIN_WINDOW = { id: 7 }

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-test-user-data', getVersion: () => '0.0.0' },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, listener),
    removeHandler: (channel: string) => state.handlers.delete(channel)
  }
}))

vi.mock('../ui', () => ({
  getTrustedUIRendererWebContents: () => MAIN_WINDOW,
  getTrustedUIRendererWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => state.sent.push([channel, payload])
    }
  })
}))

vi.mock('../../wsl/host-lifecycle/wsl-host-gate', () => ({
  wslHostsGateOpen: () => state.gateOpen,
  wslHostsOptedIn: () => state.gateOpen,
  wslHostsAcceptNewWork: () => state.gateOpen
}))

// Stands in for the real class: its constructor adopts the sidecar, which these records represent.
vi.mock('../../persistence/moving-wsl-projects/wsl-move-orchestrator', () => ({
  WslMoveOrchestrator: class {
    constructor() {
      state.constructed += 1
    }
    list() {
      return SIDECAR_RECORDS
    }
    trigger(distro: string, trigger: string) {
      state.triggers.push([distro, trigger])
      return Promise.resolve()
    }
  }
}))

async function load() {
  const instance = await import('../../wsl/host-lifecycle/wsl-host-service-instance')
  const wiring = await import('./wsl-move-orchestrator-wiring')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction reads only getSettings.
  const store = { getSettings: () => ({ experimentalWslHosts: true }) } as never
  const register = () =>
    wiring.registerWslMoveOrchestrator(store, () => {
      throw new Error('driver not used')
    })
  const installService = () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start reads only these two members.
    instance.setWslHostService({
      getStatuses: () => [],
      onStatusesChanged: () => () => {}
    } as never)
  const list = () => state.handlers.get('wslMoveOrchestrator:list')?.()
  return { register, installService, list }
}

describe('registerWslMoveOrchestrator', () => {
  beforeEach(() => {
    vi.resetModules()
    state.handlers.clear()
    state.constructed = 0
    state.triggers.length = 0
    state.sent.length = 0
    state.gateOpen = true
  })

  // Startup registers this before the host service is installed.
  it('builds the orchestrator once when the host service is set after registration', async () => {
    const { register, installService, list } = await load()
    register()
    expect(list()).toBeNull()
    expect(state.constructed).toBe(0)

    installService()
    installService()

    expect(state.constructed).toBe(1)
    expect(list()).toEqual(SIDECAR_RECORDS)
  })

  it('builds at once when the host service is already set', async () => {
    const { register, installService, list } = await load()
    installService()
    register()
    expect(state.constructed).toBe(1)
    expect(list()).toEqual(SIDECAR_RECORDS)
  })

  it('replays a project-opened that arrived before the host service', async () => {
    const { register, installService } = await load()
    register()
    const opened = state.handlers.get('wslMoveOrchestrator:projectOpened')
    opened?.({ sender: MAIN_WINDOW }, 'Ubuntu')
    opened?.({ sender: { id: 99 } }, 'Debian')
    expect(state.triggers).toEqual([])

    installService()

    expect(state.triggers).toEqual([['Ubuntu', 'project-opened']])
  })

  it('publishes the adopted sidecar records on construction', async () => {
    const { register, installService } = await load()
    register()
    installService()
    expect(state.sent).toEqual([['wslMoveOrchestrator:status', SIDECAR_RECORDS]])
  })

  it('builds nothing while the gate is closed', async () => {
    state.gateOpen = false
    const { register, installService, list } = await load()
    register()
    installService()
    expect(state.constructed).toBe(0)
    expect(list()).toEqual([])
  })
})
