import { describe, expect, it } from 'vitest'
import type * as TranscribeCpp from 'transcribe-cpp'
import { LiveDecode } from './stt-live-decode'

// One scripted decode step per feed: the text so far and how much audio (ms) the stream has decoded.
function fakeSession(steps: { text: string; decodedMs: number }[]) {
  let step = -1
  const stream = {
    feed: async () => {
      step += 1
      return { resultChanged: true, audioCommittedMs: steps[step].decodedMs }
    },
    finalize: async () => ({}),
    get text() {
      return { full: steps[step].text }
    },
    reset: () => {}
  }
  const session = {
    stream: async () => stream
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: LiveDecode calls only stream(), feed(), finalize(), text and reset().
  return session as unknown as TranscribeCpp.Session
}

describe('LiveDecode', () => {
  it('shows text as it grows and commits it once quiet, covering up to a second before the decode', async () => {
    const session = fakeSession([
      { text: 'I have', decodedMs: 1120 },
      { text: 'I have two questions', decodedMs: 2240 },
      { text: 'I have two questions', decodedMs: 3360 },
      { text: 'I have two questions', decodedMs: 4480 },
      { text: 'I have two questions. First', decodedMs: 5600 }
    ])
    const live = new LiveDecode(session, {}, 16000, null)
    const feed = (index: number) => live.feed(new Float32Array(17920), 32000 + 17920 * (index + 1))

    expect(await feed(0)).toEqual({ type: 'partial', text: 'I have' })
    expect(await feed(1)).toEqual({ type: 'partial', text: 'I have two questions' })
    expect(await feed(2)).toBeNull()
    // Started at 32000 samples (2 s in); quiet from 2.24 s decoded, committed up to 3.48 s decoded.
    expect(await feed(3)).toEqual({
      type: 'quiet',
      text: 'I have two questions',
      covered: 32000 + 55680
    })
    expect(await feed(4)).toEqual({ type: 'partial', text: '. First' })
    expect(await live.end(true)).toBe('. First')
  })
})
