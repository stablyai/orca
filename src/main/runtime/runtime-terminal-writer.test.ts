import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../shared/terminal-input'

afterEach(() => vi.useRealTimers())

describe('requested terminal write settlement', () => {
  it('waits for complete body settlement before suffix and host acknowledgment', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const bytes: string[] = []
    let finish: (result: WriteSettlement) => void = () => {
      throw new Error('write not started')
    }
    const settled = vi.fn((_id: string, data: string) => {
      bytes.push(data)
      return bytes.length === 1
        ? new Promise<WriteSettlement>((resolve) => {
            finish = resolve
          })
        : WRITE_ACCEPTED
    })
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    const text = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving',
      requireWriteSettlement: true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(bytes).toHaveLength(1)
    finish(WRITE_ACCEPTED)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toEqual(WRITE_ACCEPTED)
    expect(bytes.join('')).toBe(`${text}\r`)
    expect(bytes.at(-1)).toBe('\r')
    expect(raw).not.toHaveBeenCalled()
  })

  it.each([
    writeRefused('endpoint_disconnected'),
    writeUnverifiable('transport_settlement_lost', true)
  ])('preserves first-write $outcome and never sends a suffix', async (verdict) => {
    const raw = vi.fn((_id: string, _data: string) => true)
    const settled = vi.fn(() => verdict)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    await expect(
      writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toEqual(verdict)
    expect(settled).toHaveBeenCalledOnce()
    expect(raw).not.toHaveBeenCalled()
  })

  it('keeps a later refusal unknown after an acknowledged prefix', async () => {
    const settled = vi
      .fn()
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockReturnValueOnce(writeRefused('transport_queue_full'))
    const writer = new RuntimeTerminalWriter(
      () => true,
      () => 'linux',
      () => null,
      settled
    )
    const text = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)
    await expect(
      writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'partial_write',
      bytesHandedToTransport: true
    })
    expect(settled).toHaveBeenCalledTimes(2)
  })

  it.each(['afterWrite', 'beforeSuffix'] as const)(
    'keeps a %s failure unknown after handing off bytes',
    async (failure) => {
      vi.useFakeTimers()
      const settled = vi.fn(() => WRITE_ACCEPTED)
      let calls = 0
      const writer = new RuntimeTerminalWriter(
        () => true,
        () => 'linux',
        () => null,
        settled
      )
      const pending = writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
        inputKind: 'driving',
        requireWriteSettlement: true,
        beforeWrite: () => {
          if (++calls > 1 && failure === 'beforeSuffix') {
            throw new Error('terminal_not_writable')
          }
        },
        afterWrite: () => {
          if (failure === 'afterWrite') {
            throw new Error('bookkeeping failed')
          }
        }
      })
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toMatchObject({
        outcome: 'unverifiable',
        bytesHandedToTransport: true
      })
      expect(settled).toHaveBeenCalledOnce()
    }
  )

  it('refuses a requested settlement before raw writes when the provider cannot settle', async () => {
    const raw = vi.fn((_id: string, _data: string) => true)
    const writer = new RuntimeTerminalWriter(raw)
    await expect(
      writer.writeAction('pty', { text: 'choice' }, 'choice', {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toEqual(writeRefused('provider_cannot_settle'))
    expect(raw).not.toHaveBeenCalled()
  })

  it('preserves legacy raw body and Enter requests without adding provider waits', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const settled = vi.fn(() => WRITE_ACCEPTED)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    const pending = writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBeUndefined()
    expect(raw.mock.calls.map((call) => call[1])).toEqual(['body', '\r'])
    expect(settled).not.toHaveBeenCalled()
  })
})
