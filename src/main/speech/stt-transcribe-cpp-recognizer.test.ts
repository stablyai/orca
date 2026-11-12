import { afterEach, describe, expect, it } from 'vitest'
import type { SttRecognizer, SttRecognizerEvent } from './stt-recognizer'
import { createTranscribeCppRecognizer } from './stt-transcribe-cpp-recognizer'
import { installFakeTranscribeCpp } from './transcribe-cpp-fake.test-fixture'

// 100 Hz audio in 0.1 s VAD frames. A sample's value names the word spoken there (1 = "one"), 0 is silence.
const RATE = 100
const WORDS = ['', 'one', 'two', 'three', 'four', 'five']

const speech = (word: number, seconds: number, rate = RATE) =>
  new Float32Array(Math.round(seconds * rate)).fill(word)
const silence = (seconds: number, rate = RATE) => new Float32Array(Math.round(seconds * rate))

function audio(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Like Parakeet, one decode is one sentence, so a phrase decoded alone ends in a full stop.
function sentence(pcm: Float32Array): string {
  const words: string[] = []
  let last = 0
  for (const sample of pcm) {
    const word = Math.round(sample)
    if (word !== 0 && word !== last) {
      words.push(WORDS[word])
    }
    last = word
  }
  const text = words.join(' ')
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : ''
}

let decode: (pcm: Float32Array) => string | Promise<string> = sentence
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  decode = sentence
})

async function start(): Promise<{ recognizer: SttRecognizer; posted: SttRecognizerEvent[] }> {
  const fake = installFakeTranscribeCpp({
    sampleRate: RATE,
    vadFrameSamples: 10,
    speechProbability: (frame) => (frame.some((sample) => Math.round(sample) !== 0) ? 0.9 : 0),
    transcribe: (pcm) => decode(pcm)
  })
  dispose = fake.dispose
  const posted: SttRecognizerEvent[] = []
  const recognizer = await createTranscribeCppRecognizer(
    {
      speechModulesDir: fake.speechModulesDir,
      modelDir: '/models/parakeet',
      files: ['model.gguf'],
      sampleRate: 16000,
      vadModelPath: '/models/silero-vad.gguf'
    },
    (event) => posted.push(event)
  )
  recognizer.open('s', [])
  return { recognizer, posted }
}

type Transcript = ({ partial: string } | { chunk: string; samples: number })[]

// Text and coverage only; loading and speech-pending events are other behaviour.
const transcript = (posted: SttRecognizerEvent[]): Transcript =>
  posted.flatMap<Transcript[number]>((event) =>
    event.type === 'partial'
      ? [{ partial: event.text }]
      : event.type === 'chunk'
        ? [{ chunk: event.text, samples: event.samples }]
        : []
  )

describe('createTranscribeCppRecognizer', () => {
  it('shows each phrase live at a pause and commits the span as one decode', async () => {
    const { recognizer, posted } = await start()
    await recognizer.feed('s', audio(speech(1, 2), silence(1), speech(2, 2), silence(1)), RATE)
    await recognizer.finish('s')

    expect(transcript(posted)).toEqual([
      { partial: 'One.' },
      { partial: 'One. Two.' },
      { chunk: 'One two.', samples: 600 }
    ])
  })

  it('commits a single-phrase span with its live text, without decoding again', async () => {
    const { recognizer, posted } = await start()
    await recognizer.feed('s', audio(speech(1, 2), silence(1)), RATE)
    decode = () => 'A second decode.'
    await recognizer.finish('s')

    expect(transcript(posted)).toEqual([{ partial: 'One.' }, { chunk: 'One.', samples: 300 }])
  })

  it('commits once 20 s of audio waits, then starts a new span', async () => {
    const { recognizer, posted } = await start()
    for (const word of [1, 2, 3, 4, 5]) {
      await recognizer.feed('s', audio(speech(word, 4), silence(1)), RATE)
    }
    await recognizer.finish('s')

    expect(transcript(posted)).toEqual([
      { partial: 'One.' },
      { partial: 'One. Two.' },
      { partial: 'One. Two. Three.' },
      { partial: 'One. Two. Three. Four.' },
      // The pause's last 0.4 s is held as the next phrase's lead-in, so it isn't covered yet.
      { chunk: 'One two three four.', samples: 1960 },
      { partial: 'Five.' },
      { chunk: 'Five.', samples: 2500 }
    ])
  })

  it('commits before a phrase that would take the span past 30 s', async () => {
    const { recognizer, posted } = await start()
    await recognizer.feed(
      's',
      audio(speech(1, 12), silence(1), speech(2, 12), silence(1), speech(3, 12), silence(1)),
      RATE
    )
    await recognizer.finish('s')

    expect(transcript(posted)).toEqual([
      { partial: 'One.' },
      { partial: 'One. Two.' },
      { chunk: 'One two.', samples: 2560 },
      { partial: 'Three.' },
      { chunk: 'Three.', samples: 3900 }
    ])
  })

  it('reports coverage in fed input samples, through resampling and dropped silence', async () => {
    const { recognizer, posted } = await start()
    // 160 Hz in 161-sample feeds: each resamples to 101 samples, so the nominal 1.6 ratio would drift.
    for (let feed = 0; feed < 6; feed += 1) {
      await recognizer.feed('s', silence(161 / 160, 160), 160)
    }
    await recognizer.feed('s', audio(speech(1, 2, 160), silence(1, 160)), 160)
    await recognizer.finish('s')

    expect(transcript(posted)).toEqual([
      // Over 5 s of silence: no text, but the host may drop that audio from its replay buffer.
      { chunk: '', samples: 893 },
      { partial: 'One.' },
      { chunk: 'One.', samples: 1446 }
    ])
  })

  // The running decode finishes; nothing after it decodes or commits, though the 26 s fed is past the 20 s commit.
  it.each<{ cancelDuring: string; expected: Transcript }>([
    { cancelDuring: 'One.', expected: [{ partial: 'One.' }] },
    { cancelDuring: 'Two.', expected: [{ partial: 'One.' }, { partial: 'One. Two.' }] }
  ])('skips the rest of a stream canceled while decoding "$cancelDuring"', async (testCase) => {
    const { recognizer, posted } = await start()
    let decodeStarted!: () => void
    const started = new Promise<void>((resolve) => (decodeStarted = resolve))
    let releaseDecode!: () => void
    const released = new Promise<void>((resolve) => (releaseDecode = resolve))
    decode = async (pcm) => {
      const text = sentence(pcm)
      if (text === testCase.cancelDuring) {
        decodeStarted()
        await released
      }
      return text
    }
    const feeding = recognizer.feed(
      's',
      audio(speech(1, 12), silence(1), speech(2, 12), silence(1)),
      RATE
    )
    await started
    recognizer.cancel('s')
    releaseDecode()
    await feeding
    recognizer.discard('s')

    expect(transcript(posted)).toEqual(testCase.expected)
  })
})
