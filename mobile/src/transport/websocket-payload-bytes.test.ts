import { describe, expect, it } from 'vitest'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

describe('websocketPayloadToUint8', () => {
  it('decodes a binary message our react-native patch hands over as base64', async () => {
    await expect(websocketPayloadToUint8({ base64: 'b2s=' })).resolves.toEqual(
      new Uint8Array([0x6f, 0x6b])
    )
  })

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
