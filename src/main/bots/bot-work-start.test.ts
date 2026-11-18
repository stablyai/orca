import { describe, expect, it, vi } from 'vitest'
import { prepareBotWorkerStart } from './bot-work-runtime'

const TURN = { botId: 'bot-1', address: { source: 'slack', externalId: 'T1:C1:1.0' } } as const

function runtime() {
  const started = vi.fn(async () => {})
  return {
    started,
    runtime: {
      bots: { list: () => [{ folderWorkspaceId: 'home' }] },
      botWork: { turnOf: async () => TURN, started },
      hostOf: () => 'local'
    }
  }
}

describe('prepareBotWorkerStart', () => {
  it("records the worker a bot's turn started, with only its ids and host", async () => {
    const { runtime: host, started } = runtime()
    prepareBotWorkerStart(host, { sessionId: 's1', workspaceId: 'folder:home' })({
      taskId: 't1',
      dispatchId: 'd1'
    })
    await vi.waitFor(() =>
      expect(started).toHaveBeenCalledWith(TURN, { taskId: 't1', dispatchId: 'd1', host: 'local' })
    )
  })

  it('records nothing for a caller outside a bot home', async () => {
    const { runtime: host, started } = runtime()
    prepareBotWorkerStart(host, { sessionId: 's1', workspaceId: 'folder:elsewhere' })({
      taskId: 't1',
      dispatchId: 'd1'
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).not.toHaveBeenCalled()
  })
})
