import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorOutbox, ConnectorOutboxSender } from './connector-outbox'

const TOO_MANY: ConnectorFailure = { ok: false, status: 429, error: null, retryAfterMs: 300_000 }

function recordingSender(
  outbox: ConnectorOutbox<string>,
  helloRev: () => number | null,
  answer: () => Promise<ConnectorFailure | null>
) {
  const sent: { batch: string[]; helloRev: number; seq: number }[] = []
  const sender = new ConnectorOutboxSender<string>(
    outbox,
    (batch, rev, seq) => {
      sent.push({ batch, helloRev: rev, seq })
      return answer()
    },
    helloRev,
    () => 0.5
  )
  return { sender, sent }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectorOutbox', () => {
  it('sends nothing without an accepted hello', async () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 10 })
    const { sender, sent } = recordingSender(
      outbox,
      () => null,
      async () => null
    )
    outbox.push('a')
    sender.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([])
  })

  it('never lets a later item overtake a refused one: the retry resends the same batch and number', async () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 2 })
    const answers: (ConnectorFailure | null)[] = [TOO_MANY, null, null]
    const { sender, sent } = recordingSender(
      outbox,
      () => 1,
      async () => answers.shift() ?? null
    )
    outbox.push('old prompt')
    sender.flush()
    await vi.advanceTimersByTimeAsync(0)
    outbox.push('linked', 'new prompt')
    sender.flush()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sent.map(({ batch, seq }) => [batch, seq])).toEqual([
      [['old prompt'], 0],
      [['old prompt'], 0],
      [['linked', 'new prompt'], 1]
    ])
  })

  it('keeps an item whose 204 lands after a newer hello went out, and sends it under that hello', async () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 10 })
    let rev: number | null = 1
    const held = Promise.withResolvers<ConnectorFailure | null>()
    const answers = [held.promise]
    const { sender, sent } = recordingSender(
      outbox,
      () => rev,
      () => answers.shift() ?? Promise.resolve(null)
    )
    outbox.push('done')
    sender.flush()
    rev = null
    held.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    rev = 2
    sender.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(({ batch, helloRev, seq }) => [batch, helloRev, seq])).toEqual([
      [['done'], 1, 0],
      [['done'], 2, 0]
    ])
  })

  it('a new hello sends at once, past the last one’s backoff', async () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 10 })
    let rev = 1
    const answers: (ConnectorFailure | null)[] = [TOO_MANY]
    const { sender, sent } = recordingSender(
      outbox,
      () => rev,
      async () => answers.shift() ?? null
    )
    outbox.push('a')
    sender.flush()
    await vi.advanceTimersByTimeAsync(0)
    rev = 2
    sender.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(({ helloRev }) => helloRev)).toEqual([1, 2])
  })

  it('restarts numbering with its first items in front, keeping only what is still wanted', () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 10 })
    outbox.push('turn end', 'prompt')
    expect(outbox.next(1)?.stamp.seq).toBe(0)
    outbox.restart(['snapshot'], (item) => item === 'turn end')
    const head = outbox.next(2)
    expect(head?.batch).toEqual(['snapshot', 'turn end'])
    expect(head?.stamp.seq).toBe(0)
  })

  it('ignores a superseded stamp', () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 10 })
    outbox.push('a')
    const old = outbox.next(1)
    outbox.restart([], () => true)
    if (old) {
      outbox.accepted(old.stamp)
    }
    expect(outbox.next(2)?.batch).toEqual(['a'])
  })

  it('splits a head the cloud refuses as too large, same number, and drops a lone item once', async () => {
    const outbox = new ConnectorOutbox<string>({ headSize: () => 4 })
    const TOO_LARGE: ConnectorFailure = { ok: false, status: 413, error: null, retryAfterMs: null }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sender, sent } = recordingSender(
      outbox,
      () => 1,
      async () => (sent.at(-1)?.batch.includes('huge') ? TOO_LARGE : null)
    )
    outbox.push('a', 'huge', 'b', 'c')
    sender.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(({ batch, seq }) => [batch, seq])).toEqual([
      [['a', 'huge', 'b', 'c'], 0],
      [['a', 'huge'], 0],
      [['a'], 0],
      [['huge', 'b', 'c'], 1],
      [['huge', 'b'], 1],
      [['huge'], 1],
      [['b', 'c'], 2]
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
