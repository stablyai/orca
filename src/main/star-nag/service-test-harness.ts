import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { StarNagService } from './service'

export type TestWindow = {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

// Why: the `vi.mock` factories must live in each test file, so files build this
// shape inside `vi.hoisted` and hand it back for the shared reset.
export type StarNagMocks = {
  appMock: { getVersion: Mock }
  browserWindowMock: { getAllWindows: Mock<() => TestWindow[]> }
  checkOrcaStarredMock: Mock
  starOrcaMock: Mock
  trackMock: Mock
  getCohortAtEmitMock: Mock<() => { nth_repo_added: number }>
  ipcMainHandleMock: Mock
}

type AgentStartedListener = (totalAgentsSpawned: number) => void
type IpcHandler = () => unknown

export type TestHarness = {
  service: StarNagService
  store: Store
  ui: PersistedUIState
  emitAgentStarted: (totalAgentsSpawned: number) => void
}

export function resetStarNagMocks(mocks: StarNagMocks): void {
  mocks.appMock.getVersion.mockReset()
  mocks.appMock.getVersion.mockReturnValue('1.2.3')
  mocks.browserWindowMock.getAllWindows.mockReset()
  mocks.browserWindowMock.getAllWindows.mockReturnValue([])
  mocks.checkOrcaStarredMock.mockReset()
  mocks.checkOrcaStarredMock.mockResolvedValue(false)
  mocks.starOrcaMock.mockReset()
  mocks.starOrcaMock.mockResolvedValue(true)
  mocks.trackMock.mockReset()
  mocks.getCohortAtEmitMock.mockReset()
  mocks.getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 3 })
  mocks.ipcMainHandleMock.mockReset()
}

export function createWindow(): TestWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
}

export function createHarness(initialUI: Partial<PersistedUIState> = {}): TestHarness {
  let totalAgentsSpawned = 45
  const listeners: AgentStartedListener[] = []
  const ui = {
    starNagAppVersion: '1.2.3',
    starNagBaselineAgents: 10,
    starNagNextThreshold: STAR_NAG_INITIAL_THRESHOLD,
    ...initialUI
  } as PersistedUIState
  const store = {
    getUI: vi.fn(() => ui),
    updateUI: vi.fn((updates: Partial<PersistedUIState>) => {
      Object.assign(ui, updates)
    })
  } as unknown as Store
  const stats = {
    onAgentStarted: vi.fn((listener: AgentStartedListener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) {
          listeners.splice(index, 1)
        }
      }
    }),
    getTotalAgentsSpawned: vi.fn(() => totalAgentsSpawned)
  } as unknown as StatsCollector

  return {
    service: new StarNagService(store, stats),
    store,
    ui,
    emitAgentStarted: (nextTotal: number) => {
      totalAgentsSpawned = nextTotal
      for (const listener of listeners) {
        listener(nextTotal)
      }
    }
  }
}

export function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

export function createIpcHandlerLookup(ipcMainHandleMock: Mock): (channel: string) => IpcHandler {
  return (channel: string) => {
    const call = ipcMainHandleMock.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel
    )
    if (!call) {
      throw new Error(`missing IPC handler for ${channel}`)
    }
    return call[1] as IpcHandler
  }
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
