import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const environment = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  getService: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (name: string, fn: (event: unknown, request: unknown) => unknown) =>
      environment.handlers.set(name, fn)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../wsl/wsl-host-connector', () => ({ createWslHostConnector: () => undefined }))
vi.mock('../wsl/wsl-orphan-holder-release', () => ({
  releaseUnwantedWslHolders: () => undefined,
  wslHolderKeepPolicy: () => undefined
}))
vi.mock('../wsl/wsl-host-e2e-fake-connector', () => ({
  createFakeWslHostConnector: () => undefined,
  readFakeWslHostsConfig: () => undefined
}))
vi.mock('../orcad/orcad-artifact-materializer', () => ({ hasOrcadTemplate: () => undefined }))
vi.mock('./wsl-host-automation-wake-wiring', () => ({
  createWslHostAutomationWake: () => undefined
}))
vi.mock('../wsl/wsl-host-gate', () => ({ wslHostsGateOpen: () => undefined }))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: environment.getService,
  setWslHostService: () => undefined
}))
vi.mock('./runtime-environments/runtime-environment-removal-cleanup', () => ({
  retireRemovedRuntimeEnvironment: () => undefined
}))
vi.mock('./runtime-environments/runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: () => undefined
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: () => undefined
}))
vi.mock('./runtime-environments/runtime-environment-request-connections', () => ({
  isRemoteRuntimeConnectionReady: () => undefined
}))
vi.mock('../ssh/orcad-terminal-census-client', () => ({
  requestOrcadTerminalCensus: () => undefined
}))
vi.mock('../wsl/wsl-orcad-host-account-push', () => ({
  changesWslHostAccounts: () => undefined,
  pushWslOrcadHostAccountEnv: () => undefined
}))
vi.mock('../wsl/wsl-orcad-host-environments', () => ({ wslOrcadHostSupports: () => undefined }))
vi.mock('../wsl/wsl-host-connection-record', () => ({
  readWslHostRecordsQuietly: () => [
    { environmentId: 'wsl:ubuntu', distro: 'Ubuntu' },
    { environmentId: 'wsl:debian', distro: 'Debian' }
  ],
  persistWslHostConnection: () => false,
  toWslHostStatus: () => ({})
}))
import { WslHostService } from '../wsl/wsl-host-service'
import { registerWslHostHandlers } from './wsl-host-handlers'

class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

function setup() {
  const service = new WslHostService({
    userDataPath: () => 'unused',
    isEnabled: () => true,
    hasServerFiles: () => true,
    publish: vi.fn(),
    pairingChanged: vi.fn(),
    ready: vi.fn(),
    removed: vi.fn()
  })
  environment.getService.mockReturnValue(service)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The adopted service avoids startup, and visible-work reports never read the store.
  const store = {} as never
  registerWslHostHandlers({ store, getUserDataPath: () => 'unused', invalidateTransport: vi.fn() })
  const handler = environment.handlers.get('wslHosts:setVisibleWork')
  if (!handler) {
    throw new Error('Missing visible-work handler')
  }
  return {
    service,
    report: (sender: Sender, ids: string[]) => handler({ sender }, { environmentIds: ids })
  }
}

describe('WSL visible work document ownership', () => {
  beforeEach(() => environment.handlers.clear())
  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    'releases a retired document and accepts its replacement after %s',
    (event) => {
      const { service, report } = setup()
      const sender = new Sender(9)
      report(sender, ['wsl:ubuntu'])
      expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)
      sender.emit(event)
      expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
      expect(sender.eventNames()).toEqual([])
      report(sender, ['wsl:ubuntu'])
      expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)
      expect(sender.listenerCount('did-navigate')).toBe(1)
      sender.emit('destroyed')
      expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    }
  )

  it('preserves same-document navigation and another window demand', () => {
    const { service, report } = setup()
    const sender = new Sender(9)
    const other = new Sender(10)
    report(sender, ['wsl:ubuntu'])
    report(other, ['wsl:debian'])
    sender.emit('did-navigate-in-page', {}, '#section', true)
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)
    sender.emit('render-process-gone')
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    expect(service.hasUserVisibleWork('Debian')).toBe(true)
    other.emit('destroyed')
    expect(service.hasUserVisibleWork('Debian')).toBe(false)
  })

  it('bounds listeners through repeated reports and ten replacement documents', () => {
    const { service, report } = setup()
    const sender = new Sender(9)
    for (let index = 0; index < 10; index++) {
      report(sender, ['wsl:ubuntu'])
      report(sender, [])
      report(sender, ['wsl:ubuntu'])
      expect(sender.listenerCount('destroyed')).toBe(1)
      expect(sender.listenerCount('did-navigate')).toBe(1)
      expect(sender.listenerCount('render-process-gone')).toBe(1)
      sender.emit(index % 2 === 0 ? 'did-navigate' : 'render-process-gone')
      expect(sender.eventNames()).toEqual([])
      expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    }
  })
})
