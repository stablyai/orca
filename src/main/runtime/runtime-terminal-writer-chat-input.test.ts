import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

function makeWriter(settle: (data: string) => WriteSettlement | Promise<WriteSettlement>) {
  const raw = vi.fn(() => true)
  const settled = vi.fn((_ptyId: string, data: string) => settle(data))
  const writer = new RuntimeTerminalWriter(
    raw,
    () => 'linux',
    () => null,
    settled
  )
  return { writer, raw, settled }
}

const LONG_TEXT = 'x'.repeat(200_000)
const CHUNKS = Array.from(iterateTerminalInputChunks(LONG_TEXT))

describe('RuntimeTerminalWriter.writeChatInputAction', () => {
  it('writes nothing once the action fence refuses', async () => {
    const { writer, raw, settled } = makeWriter(() => WRITE_ACCEPTED)
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: 'rm -rf build', enter: true },
      { inputKind: 'driving', admit: () => 'refused' }
    )
    expect(result).toEqual({ accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' })
    expect(settled).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
  })

  it('stops between chunks when the pane stops showing chat mid-write and reports the settled prefix', async () => {
    expect(CHUNKS.length).toBeGreaterThan(2)
    let admits = 0
    const { writer, settled } = makeWriter(() => WRITE_ACCEPTED)
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: LONG_TEXT, enter: true },
      { inputKind: 'driving', admit: () => (++admits <= 1 ? 'admitted' : 'refused') }
    )
    expect(settled).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      accepted: false,
      bytesWritten: Buffer.byteLength(CHUNKS[0]!, 'utf8'),
      refusedReason: 'agent-exited'
    })
  })

  it('refuses with zero bytes and no suffix when the transport refuses the first chunk', async () => {
    const { writer, settled } = makeWriter(() => writeRefused('endpoint_disconnected'))
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: 'hello', enter: true },
      { inputKind: 'driving', admit: () => 'admitted' }
    )
    expect(result).toEqual({ accepted: false, bytesWritten: 0 })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('reports a lost settlement as delivery-unknown, never a zero-byte refusal, and stops', async () => {
    const { writer, settled } = makeWriter(() =>
      writeUnverifiable('transport_settlement_lost', true)
    )
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: 'hello', enter: true },
      { inputKind: 'driving', admit: () => 'admitted' }
    )
    expect(result).toEqual({ accepted: false, bytesWritten: 0, deliveryUnknown: true })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('counts an accepted prefix before a refusal', async () => {
    let calls = 0
    const { writer } = makeWriter(() =>
      ++calls === 1 ? WRITE_ACCEPTED : writeRefused('transport_queue_full')
    )
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: LONG_TEXT },
      { inputKind: 'driving', admit: () => 'admitted' }
    )
    expect(result).toEqual({ accepted: false, bytesWritten: Buffer.byteLength(CHUNKS[0]!, 'utf8') })
  })

  it('admits each chunk only after its own waits, right before the transport write', async () => {
    const order: string[] = []
    const { writer } = makeWriter(() => {
      order.push('write')
      return WRITE_ACCEPTED
    })
    await writer.writeChatInputAction(
      'pty-1',
      { text: 'hi' },
      {
        inputKind: 'driving',
        beforeWrite: async () => {
          order.push('beforeWrite')
        },
        admit: async () => {
          order.push('admit')
          return 'admitted' as const
        }
      }
    )
    expect(order).toEqual(['beforeWrite', 'admit', 'write'])
  })

  it('reports a throwing transport after a settled prefix as unconfirmed, keeping the prefix (R1B-N1)', async () => {
    let calls = 0
    const { writer } = makeWriter(() => {
      calls += 1
      if (calls === 2) {
        throw new Error('socket closed')
      }
      return WRITE_ACCEPTED
    })
    const result = await writer.writeChatInputAction(
      'pty-1',
      { text: LONG_TEXT },
      { inputKind: 'driving', admit: () => 'admitted' }
    )
    expect(result).toEqual({
      accepted: false,
      bytesWritten: Buffer.byteLength(CHUNKS[0]!, 'utf8'),
      deliveryUnknown: true
    })
  })

  it('writes body then the separate Enter and accepts with the full byte count (SSH-style async settlement)', async () => {
    vi.useFakeTimers()
    try {
      const { writer, settled } = makeWriter(async () => WRITE_ACCEPTED)
      const pending = writer.writeChatInputAction(
        'pty-1',
        { text: 'hello', enter: true },
        { inputKind: 'driving', admit: () => 'admitted' }
      )
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toEqual({ accepted: true, bytesWritten: 6 })
      expect(settled.mock.calls.map((call) => call[1])).toEqual(['hello', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })
})
