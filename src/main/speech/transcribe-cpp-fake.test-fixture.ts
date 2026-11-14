import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VadStream } from './stt-vad-pause-segmenter'

export type FakeTranscribeEngine = {
  /** The speech model's native rate; the VAD takes the same rate. */
  sampleRate: number
  /** Samples per VAD probability. */
  vadFrameSamples: number
  /** Speech probability of one VAD frame (the last one of a flush is zero padded). */
  speechProbability: (frame: Float32Array) => number
  /** Text of one decode of this audio. */
  transcribe: (pcm: Float32Array) => string | Promise<string>
}

class OutputTruncated extends Error {
  partialResult?: { text: string }
}

/** A Silero VAD stream scoring each frame with `speechProbability`. */
export function fakeVadSession(
  frameSamples: number,
  speechProbability: (frame: Float32Array) => number
): VadStream & { dispose: () => void } {
  let pending: number[] = []
  let frames = 0
  const score = (flush: boolean) => {
    const probs: number[] = []
    while (pending.length >= frameSamples || (flush && pending.length > 0)) {
      const frame = new Float32Array(frameSamples)
      frame.set(pending.slice(0, frameSamples))
      probs.push(speechProbability(frame))
      pending = pending.slice(frameSamples)
    }
    const firstFrame = frames
    frames = flush ? 0 : frames + probs.length
    return { probs, firstFrame, segments: [] }
  }
  return {
    streamFeed: async (pcm) => {
      if (!(pcm instanceof Float32Array)) {
        throw new Error('the segmenter feeds Float32Array')
      }
      pending.push(...pcm)
      return score(false)
    },
    streamFlush: async () => score(true),
    dispose: () => {}
  }
}

function fakeModel(engine: FakeTranscribeEngine) {
  const languages: string[] = []
  return {
    capabilities: { nativeSampleRate: engine.sampleRate, languages },
    vadInfo: { sampleRate: engine.sampleRate, frameSamples: engine.vadFrameSamples },
    supports: () => false,
    createSession: () => ({
      run: async (pcm: Float32Array) => ({ text: await engine.transcribe(pcm) })
    }),
    createVadSession: () => fakeVadSession(engine.vadFrameSamples, engine.speechProbability),
    dispose: () => {}
  }
}

const MODULE_KEY = Symbol.for('orca.test.fakeTranscribeCpp')

/**
 * Writes a transcribe-cpp package backed by `engine` and returns the node_modules directory holding it, so the
 * recognizer loads it the way it loads the real one. The package reads the engine from a global, which works
 * whether the test runner transforms the file or Node loads it natively.
 */
export function installFakeTranscribeCpp(engine: FakeTranscribeEngine): {
  speechModulesDir: string
  dispose: () => void
} {
  const speechModulesDir = mkdtempSync(join(tmpdir(), 'orca-fake-transcribe-cpp-'))
  const dist = join(speechModulesDir, 'transcribe-cpp', 'dist')
  mkdirSync(dist, { recursive: true })
  Reflect.set(globalThis, MODULE_KEY, {
    initialize: async () => {},
    OutputTruncated,
    TranscribeModel: {
      // One model serves both roles: speech decodes and the Silero VAD.
      load: async () => fakeModel(engine)
    }
  })
  writeFileSync(join(speechModulesDir, 'transcribe-cpp', 'package.json'), '{"type":"module"}\n')
  writeFileSync(
    join(dist, 'index.js'),
    `const fake = globalThis[Symbol.for('orca.test.fakeTranscribeCpp')]
export const { initialize, OutputTruncated, TranscribeModel } = fake
`
  )
  return {
    speechModulesDir,
    dispose: () => {
      Reflect.deleteProperty(globalThis, MODULE_KEY)
      rmSync(speechModulesDir, { recursive: true, force: true })
    }
  }
}
