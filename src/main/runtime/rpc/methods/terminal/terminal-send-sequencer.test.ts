import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_SEND_OUT_OF_SEQUENCE,
  TERMINAL_SEND_SEQUENCE_GAP_HOLD_MS,
  TerminalSendSequencer
} from './terminal-send-sequencer'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('TerminalSendSequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a later send until the earlier one has finished, however fast the later one is', async () => {
    const sequencer = new TerminalSendSequencer()
    const applied: string[] = []
    const firstWrite = deferred()

    const first = sequencer.run('s', 1, undefined, async () => {
      await firstWrite.promise
      applied.push('first')
    })
    const second = sequencer.run('s', 2, undefined, async () => {
      applied.push('second')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual([])

    firstWrite.resolve()
    await Promise.all([first, second])
    expect(applied).toEqual(['first', 'second'])
  })

  it('applies sends in sequence order when they arrive reversed', async () => {
    const sequencer = new TerminalSendSequencer()
    const applied: number[] = []
    const apply = (seq: number) => async () => {
      applied.push(seq)
    }

    const third = sequencer.run('s', 3, undefined, apply(3))
    const second = sequencer.run('s', 2, undefined, apply(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual([])

    await sequencer.run('s', 1, undefined, apply(1))
    await Promise.all([second, third])
    expect(applied).toEqual([1, 2, 3])
  })

  it('gives up on a missing send after the hold and refuses it if it turns up later', async () => {
    const sequencer = new TerminalSendSequencer()
    const applied: number[] = []
    const apply = (seq: number) => async () => {
      applied.push(seq)
    }

    const third = sequencer.run('s', 3, undefined, apply(3))
    await sequencer.run('s', 1, undefined, apply(1))
    await vi.advanceTimersByTimeAsync(TERMINAL_SEND_SEQUENCE_GAP_HOLD_MS - 1)
    expect(applied).toEqual([1])

    await vi.advanceTimersByTimeAsync(1)
    await third
    expect(applied).toEqual([1, 3])
    await expect(sequencer.run('s', 2, undefined, apply(2))).resolves.toBe(
      TERMINAL_SEND_OUT_OF_SEQUENCE
    )
    expect(applied).toEqual([1, 3])
  })

  it('refuses a repeated sequence number', async () => {
    const sequencer = new TerminalSendSequencer()
    const apply = vi.fn(async () => 'applied')

    await expect(sequencer.run('s', 1, undefined, apply)).resolves.toBe('applied')
    await expect(sequencer.run('s', 1, undefined, apply)).resolves.toBe(
      TERMINAL_SEND_OUT_OF_SEQUENCE
    )
    expect(apply).toHaveBeenCalledOnce()
  })

  it('keeps applying after a send fails', async () => {
    const sequencer = new TerminalSendSequencer()
    const failed = sequencer.run('s', 1, undefined, async () => {
      throw new Error('terminal_not_writable')
    })
    const next = sequencer.run('s', 2, undefined, async () => 'applied')

    await expect(failed).rejects.toThrow('terminal_not_writable')
    await expect(next).resolves.toBe('applied')
  })

  it('drops a held send whose request is aborted without stalling the ones behind it', async () => {
    const sequencer = new TerminalSendSequencer()
    const abort = new AbortController()
    const applied: number[] = []
    const firstWrite = deferred()

    const first = sequencer.run('s', 1, undefined, async () => {
      await firstWrite.promise
      applied.push(1)
    })
    const second = sequencer.run('s', 2, abort.signal, async () => {
      applied.push(2)
    })
    const third = sequencer.run('s', 3, undefined, async () => {
      applied.push(3)
    })
    abort.abort()
    firstWrite.resolve()

    await expect(second).rejects.toThrow('request_aborted')
    await Promise.all([first, third])
    expect(applied).toEqual([1, 3])
  })

  it('orders each stream on its own', async () => {
    const sequencer = new TerminalSendSequencer()
    const blocked = deferred()
    const applied: string[] = []

    const slow = sequencer.run('keys', 1, undefined, async () => {
      await blocked.promise
      applied.push('keys')
    })
    await sequencer.run('gestures', 1, undefined, async () => {
      applied.push('gestures')
    })
    expect(applied).toEqual(['gestures'])

    blocked.resolve()
    await slow
    expect(applied).toEqual(['gestures', 'keys'])
  })
})
