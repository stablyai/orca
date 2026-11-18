import { describe, expect, it, vi } from 'vitest'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { webhookCloudCalls } from './webhook-cloud-routes'

describe('webhookCloudCalls', () => {
  it("mints a bot's hook while holding the connection, since the cloud knows a bot only from a hello", async () => {
    const order: string[] = []
    const cloud: Pick<ConnectorCloud, 'call' | 'withConnection'> = {
      call: vi.fn(async () => {
        order.push('mint')
        return { ok: false as const, status: 503, error: null, retryAfterMs: null }
      }),
      withConnection: async (run) => {
        order.push('held')
        const result = await run()
        order.push('released')
        return result
      }
    }
    await webhookCloudCalls(() => cloud).mint({
      operationId: 'op-1',
      automationId: 'auto-1',
      botId: 'bot-1'
    })
    expect(order).toEqual(['held', 'mint', 'released'])
  })
})
