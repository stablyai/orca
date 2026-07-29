import { describe, expect, it } from 'vitest'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

describe('websocketPayloadToUint8', () => {
  it('returns null when a blob-like payload rejects arrayBuffer conversion', async () => {
    await expect(
      websocketPayloadToUint8({
        arrayBuffer: async () => {
          throw new Error('conversion failed')
        }
      })
    ).resolves.toBeNull()
  })
})
