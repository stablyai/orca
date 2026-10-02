import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getServeOptions, printServeReady } from './main-process-serve'

const { status, notify, publish } = vi.hoisted(() => ({
  status: { graphStatus: 'ready' } satisfies Pick<RuntimeStatus, 'graphStatus'>,
  notify: vi.fn(),
  publish: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({ app: {} }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    runtime: { getRuntimeId: () => 'current-runtime', getStatus: () => status },
    runtimeRpc: { getWebSocketEndpoint: () => null },
    serveReadinessPublisher: { publish }
  }
}))
vi.mock('../serve-update-handoff', () => ({ notifyServeSupervisorReady: notify }))

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('current runtime serve readiness', () => {
  it.each(['ready', 'unavailable'] as const)(
    'publishes the current graphStatus without reporting an unavailable graph as ready: %s',
    async (graphStatus) => {
      const current: Pick<RuntimeStatus, 'graphStatus'> = { graphStatus }
      Object.assign(status, current)
      await printServeReady(getServeOptions(['--serve', '--no-pairing']))
      expect(publish).toHaveBeenCalledOnce()
      expect(notify).toHaveBeenCalledWith('current-runtime', {
        websocket: 'ready',
        runtime: 'ready',
        graph: graphStatus
      })
    }
  )
})
