import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, constructed } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  constructed: { count: 0 }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-test-user-data', getVersion: () => '0.0.0' },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

vi.mock('../ui', () => ({
  getTrustedUIRendererWebContents: () => null,
  getTrustedUIRendererWindow: () => null
}))

vi.mock('../../wsl/host-lifecycle/wsl-host-gate', () => ({
  wslHostsGateOpen: () => true,
  wslHostsOptedIn: () => true
}))

vi.mock('../../persistence/moving-wsl-projects/wsl-move-orchestrator', () => ({
  WslMoveOrchestrator: class {
    constructor() {
      constructed.count += 1
    }
    list() {
      return [{ distro: 'Ubuntu' }]
    }
    trigger() {
      return Promise.resolve()
    }
  }
}))

import { setWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import type { WslHostService } from '../../wsl/host-lifecycle/wsl-host-service'
import type { Store } from '../../persistence/loading-store/store'
import { registerWslMoveOrchestrator } from './wsl-move-orchestrator-wiring'

const fakeService = (): WslHostService =>
  ({ getStatuses: () => [], onStatusesChanged: () => () => {} }) as unknown as WslHostService

describe('registerWslMoveOrchestrator', () => {
  beforeEach(() => {
    constructed.count = 0
  })

  // Startup registers this before the host service is installed; the service arriving later must build it.
  it('builds the orchestrator once when the host service is set after registration', () => {
    setWslHostService(null)
    const store = { getSettings: () => ({ experimentalWslHosts: true }) } as unknown as Store
    registerWslMoveOrchestrator(store, () => {
      throw new Error('driver not used')
    })
    expect(handlers.get('wslMoveOrchestrator:list')?.()).toEqual([])
    expect(constructed.count).toBe(0)

    setWslHostService(fakeService())
    setWslHostService(fakeService())

    expect(constructed.count).toBe(1)
    expect(handlers.get('wslMoveOrchestrator:list')?.()).toEqual([{ distro: 'Ubuntu' }])
  })
})
