import type { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'
import type { WriteSettlement } from '../../shared/pty-write-settlement'

it('preserves ambiguity when arming daemon recovery triggers a throwing listener', async () => {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/unused/socket',
    tokenPath: '/unused/token',
    respawn: async () => {}
  })
  const state = adapter as unknown as {
    ensureConnected: () => Promise<void>
    activeSessionIds: Set<string>
    client: {
      isConnected: () => boolean
      notifyWithSettlement: (type: string, payload: unknown) => Promise<WriteSettlement>
    }
  }
  vi.spyOn(state, 'ensureConnected').mockResolvedValue()
  state.activeSessionIds.add('pty-1')
  vi.spyOn(state.client, 'isConnected').mockReturnValue(true)
  const transported: string[] = []
  const socket = {
    write: (encoded: string, callback: (error: Error) => void) => {
      transported.push(encoded)
      callback(new Error('connection lost after handoff'))
    }
  } as unknown as Socket
  vi.spyOn(state.client, 'notifyWithSettlement').mockImplementation((type, payload) =>
    writeNotifyWithSettlement({
      socket,
      message: { type, payload },
      timeoutMs: 100,
      onUndeliverable: () => {}
    })
  )
  adapter.onWriteUnavailable(() => {
    throw new Error('renderer send failed')
  })
  try {
    await expect(adapter.writeWithSettlement('pty-1', 'pointer')).resolves.toEqual({
      outcome: 'unverifiable',
      reason: 'transport_settlement_lost',
      bytesHandedToTransport: true
    })
    expect(transported).toHaveLength(1)
    expect(state.ensureConnected).toHaveBeenCalledOnce()
  } finally {
    adapter.dispose()
  }
})
