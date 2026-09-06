import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'

describe('daemon notify partial handoff', () => {
  it.each(['pointer', '\r'])(
    'retains possible handoff after writing %j then throwing',
    async (data) => {
      const transported: string[] = []
      const socket = {
        write: (encoded: string) => {
          transported.push(encoded.slice(0, -1))
          throw new Error('socket failed after partial flush')
        }
      } as unknown as Socket
      const onUndeliverable = vi.fn()

      const settlement = await writeNotifyWithSettlement({
        socket,
        message: { id: 'notify-1', type: 'write', payload: { sessionId: 'pty-1', data } },
        timeoutMs: 100,
        onUndeliverable
      })

      expect(transported).toHaveLength(1)
      expect(settlement).toEqual({
        outcome: 'unverifiable',
        reason: 'endpoint_write_threw',
        bytesHandedToTransport: true
      })
      expect(onUndeliverable).toHaveBeenCalledOnce()
    }
  )
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
