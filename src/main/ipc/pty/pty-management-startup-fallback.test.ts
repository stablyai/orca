import { beforeEach, expect, it, vi } from 'vitest'

const { handlers, provider, fellBack } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<{ freshTerminalsInProcess: boolean }>>(),
  provider: vi.fn<() => object | null>(),
  fellBack: vi.fn<() => boolean>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, handler: () => Promise<{ freshTerminalsInProcess: boolean }>) =>
      handlers.set(name, handler)
  }
}))
vi.mock('../../daemon/daemon-provider-state', () => ({ getDaemonProvider: provider }))
vi.mock('../../daemon/daemon-startup-fallback', () => ({ didDaemonStartupFallBack: fellBack }))

import { registerDaemonManagementHandlers } from './pty-management'

beforeEach(() => {
  vi.clearAllMocks()
  provider.mockReturnValue(null)
  fellBack.mockReturnValue(false)
  registerDaemonManagementHandlers()
})

async function read(): Promise<{ freshTerminalsInProcess: boolean } | undefined> {
  return handlers.get('pty:management:startupFallback')?.()
}

it('reports in-process terminals after startup fell back without a daemon provider', async () => {
  fellBack.mockReturnValue(true)
  expect(await read()).toEqual({ freshTerminalsInProcess: true })
})

it('stays quiet before startup settles and once a daemon owns fresh terminals', async () => {
  expect(await read()).toEqual({ freshTerminalsInProcess: false })
  fellBack.mockReturnValue(true)
  provider.mockReturnValue({})
  expect(await read()).toEqual({ freshTerminalsInProcess: false })
})
