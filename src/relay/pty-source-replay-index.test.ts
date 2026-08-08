import { describe, expect, it } from 'vitest'
import type { PtySourceSpan } from '../shared/pty-source-credit-contract'
import { PtySourceReplayIndex } from './pty-source-replay-index'

function span(id: string, data: string, sourceStartSu: number): PtySourceSpan {
  return {
    id: 'pty-1',
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    spanId: id,
    sourceStartSu,
    sourceEndSu: sourceStartSu + data.length,
    displayStart: sourceStartSu,
    displayEnd: sourceStartSu + data.length,
    data,
    splittable: true,
    transform: { transformed: false, rawLengthSu: data.length, scalarSafe: true }
  }
}

describe('PtySourceReplayIndex', () => {
  it('wraps the existing chunked buffer and preserves exact retained source ranges', () => {
    const replay = new PtySourceReplayIndex(6)
    replay.append(span('one', 'abcd', 0))
    replay.append(span('two', 'efgh', 4))

    expect(replay.readLegacy()).toBe('cdefgh')
    expect(replay.recoveryFrom(3)).toEqual({
      ok: true,
      records: [
        expect.objectContaining({ sourceStartSu: 3, data: 'd' }),
        expect.objectContaining({ sourceStartSu: 4, data: 'efgh' })
      ],
      liveEndSourceSu: 8
    })
    expect(replay.recoveryFrom(1)).toMatchObject({
      ok: false,
      reason: 'checkpoint-before-retained-range'
    })
  })

  it('does not wall-clock dedupe identical replay payloads', () => {
    const first = new PtySourceReplayIndex(16)
    const second = new PtySourceReplayIndex(16)
    first.append(span('first', 'same', 0))
    second.append({ ...span('second', 'same', 0), deliveryToken: 'token-2' })

    expect(first.recoveryFrom(0)).toMatchObject({ ok: true })
    expect(second.recoveryFrom(0)).toMatchObject({ ok: true })
  })

  it('preserves indivisible-form split metadata during recovery', () => {
    const replay = new PtySourceReplayIndex(16)
    replay.append({
      ...span('range', 'abcd', 0),
      splittable: undefined,
      indivisible: false
    })

    expect(replay.recoveryFrom(2)).toMatchObject({
      ok: true,
      records: [expect.objectContaining({ sourceStartSu: 2, data: 'cd' })]
    })
  })

  it('rejects replay checkpoints and retained heads inside a scalar', () => {
    const replay = new PtySourceReplayIndex(4)
    replay.append(span('range', 'a😀b', 0))
    expect(replay.recoveryFrom(2)).toMatchObject({
      ok: false,
      reason: 'checkpoint-inside-scalar'
    })

    const trimmed = new PtySourceReplayIndex(1)
    trimmed.append(span('emoji', '😀', 0))
    expect(trimmed.recoveryFrom(1)).toMatchObject({
      ok: false,
      reason: 'checkpoint-before-retained-range',
      retainedStartSourceSu: 2
    })
  })

  it('rejects a recovery checkpoint beyond the live source range', () => {
    const replay = new PtySourceReplayIndex(16)
    replay.append(span('range', 'abcd', 0))

    expect(replay.recoveryFrom(5)).toMatchObject({
      ok: false,
      reason: 'checkpoint-after-live-range',
      liveEndSourceSu: 4
    })
  })
})
