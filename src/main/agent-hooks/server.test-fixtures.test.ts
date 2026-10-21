import type { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

class SocketTrackingHookServer extends AgentHookServer {
  readonly requestSockets = new Set<Socket>()

  trackRequestSockets(): void {
    this.server?.on('request', (request) => this.requestSockets.add(request.socket))
  }
}

it('uses a fresh connection for each hook across fake-time advances', async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']
  })
  const server = new SocketTrackingHookServer()
  try {
    await server.start({ env: 'production' })
    server.trackRequestSockets()
    for (let index = 0; index < 3; index += 1) {
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'fresh turn' })
      )
      expect(response.status).toBe(204)
      if (index === 1) {
        vi.advanceTimersByTime(120_000)
      }
    }
    expect(server.requestSockets.size).toBe(3)
  } finally {
    server.stop()
    vi.useRealTimers()
  }
})
