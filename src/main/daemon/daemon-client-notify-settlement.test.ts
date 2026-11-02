import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'

describe('daemon notify partial handoff', () => {
  it('preserves the write verdict when disconnect notification throws', async () => {
    const socket = {
      write: () => {
        throw new Error('partial flush')
      }
    } as unknown as Socket
    await expect(
      writeNotifyWithSettlement({
        socket,
        message: { type: 'write', payload: { data: 'pointer' } },
        timeoutMs: 100,
        onUndeliverable: () => {
          throw new Error('renderer destroyed during disconnect')
        }
      })
    ).resolves.toEqual({
      outcome: 'unverifiable',
      reason: 'endpoint_write_threw',
      bytesHandedToTransport: true
    })
  })
})
