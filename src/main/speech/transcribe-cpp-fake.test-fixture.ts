import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function fakeVadSession(engine: FakeTranscribeEngine) {
  let pending: number[] = []
  const score = (flush: boolean) => {
    const size = engine.vadFrameSamples
    const probs: number[] = []
    while (pending.length >= size || (flush && pending.length > 0)) {
      const frame = new Float32Array(size)
      frame.set(pending.slice(0, size))
      probs.push(engine.speechProbability(frame))
      pending = pending.slice(size)
    }
    return { probs, firstFrame: 0, segments: [] }
  }
  return {
    streamFeed: async (pcm: Float32Array) => {
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
      // Copied, as native code borrows the caller's buffer only until the run settles.
      run: async (pcm: Float32Array) => ({ text: await engine.transcribe(pcm.slice()) })
    }),
    createVadSession: () => fakeVadSession(engine),
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
