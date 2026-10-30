import { afterEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => ({ calls: new Array<string>(), serving: true }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
vi.mock('../wsl/wsl-host-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wslHostsServing: () => order.serving
}))
vi.mock('../../shared/runtime-environment-wsl-host-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileWslHostBridgePorts: () => {
    order.calls.push('reconcile')
    return []
  }
}))
vi.mock('../wsl/wsl-host-connector', () => ({ createWslHostConnector: vi.fn() }))
vi.mock('../wsl/wsl-host-e2e-fake-connector', () => ({
  readFakeWslHostsConfig: () => ({ serverFiles: 'present' }),
  createFakeWslHostConnector: () => {
    order.calls.push('connector')
    return {
      connect: async () => {
        order.calls.push('connect')
      }
    }
  }
}))
vi.mock('../wsl/wsl-orphan-holder-release', () => ({
  releaseUnwantedWslHolders: async () => {},
  wslHolderKeepPolicy: () => () => true
}))
vi.mock('./wsl-host-automation-wake-wiring', () => ({ createWslHostAutomationWake: () => null }))
vi.mock('../wsl/wsl-host-service', () => ({
  WslHostService: class {
    connector: { connect: (distro: string) => Promise<void> } | null = null
    attach(connector: { connect: (distro: string) => Promise<void> }): void {
      this.connector = connector
    }
    handleConnectionChange(): void {}
    isKnownDistro(): boolean {
      return true
    }
    hasUserVisibleWork(): boolean {
      return false
    }
    // Startup's first bridge work: adopting holders, then any reconnect.
    async start(): Promise<void> {
      order.calls.push('start')
      await this.connector?.connect('Ubuntu')
    }
  }
}))
const instance = vi.hoisted((): { service: unknown } => ({ service: null }))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => instance.service,
  setWslHostService: (service: unknown) => {
    instance.service = service
  },
  // The phone's gate is built beside the service; startup order is all this suite checks.
  setWslHostPhoneGate: () => {}
}))

import { registerWslHostHandlers } from './wsl-host-handlers'

function register(): void {
  registerWslHostHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup reads settings only through onSettingsChanged.
    store: { getSettings: () => ({}), onSettingsChanged: vi.fn() } as never,
    getUserDataPath: () => '/user-data',
    invalidateTransport: vi.fn()
  })
}

// A crash between a pairing save's two writes hides the host unless its record is realigned first.
describe('WSL host startup: the bridge-port reconcile', () => {
  afterEach(() => {
    order.calls = []
    order.serving = true
    instance.service = null
  })

  it('realigns saved records before the connector exists or any bridge connects', async () => {
    register()
    await vi.waitFor(() => expect(order.calls).toContain('connect'))
    expect(order.calls).toEqual(['reconcile', 'connector', 'start', 'connect'])
  })

  it('reads and writes no record while WSL hosts are not serving', () => {
    order.serving = false
    register()
    expect(order.calls).toEqual([])
    expect(instance.service).toBeNull()
  })
})
