import { describe, expect, it } from 'vitest'
import { createDirectRequestPipeline } from './direct-request-pipeline'

describe('createDirectRequestPipeline', () => {
  it('shares one id sequence across requests and streams', () => {
    const pipeline = createDirectRequestPipeline({
      deviceToken: 'device-token',
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendEncrypted: () => true
    })

    expect(pipeline.requests).toBeDefined()
    expect(pipeline.streams).toBeDefined()
    const first = pipeline.nextId()
    const second = pipeline.nextId()
    expect(first).toMatch(/^rpc-1-\d+$/)
    expect(second).toMatch(/^rpc-2-\d+$/)
  })
})
