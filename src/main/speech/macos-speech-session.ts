import { runProcess } from '@orca/process-host'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encodePcm16Wav } from './openai-transcription-client'
import { resampleToRate } from './stt-audio-resample'
import { isMacosTahoeOrNewer } from '../window/macos-tahoe-release'
import { getMacosSpeechHelperPath } from './macos-speech-helper'

let preparation: Promise<void> | undefined

export function prepareMacosSpeech(): Promise<void> {
  preparation ??= runMacosSpeech(['--prepare'], 10 * 60_000)
    .then(() => undefined)
    .finally(() => {
      preparation = undefined
    })
  return preparation
}

async function runMacosSpeech(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  if (process.platform !== 'darwin' || !isMacosTahoeOrNewer()) {
    throw new Error('macOS speech recognition is only available on macOS 26 or newer')
  }
  const helper = getMacosSpeechHelperPath()
  if (!helper) {
    throw new Error('macOS Speech helper is unavailable on this host. Select another speech model.')
  }
  const result = await runProcess({
    program: helper,
    args,
    timeoutMs,
    signal,
    maxOutputBytes: 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || 'macOS speech recognition failed or timed out')
  }
  return result.stdout.trim()
}

export class MacosSpeechSession {
  private chunks: Float32Array[] = []
  private samples = 0
  private readonly abortController = new AbortController()

  constructor() {
    if (process.platform !== 'darwin' || !isMacosTahoeOrNewer()) {
      throw new Error('macOS speech recognition is only available on macOS 26 or newer')
    }
    if (!getMacosSpeechHelperPath()) {
      throw new Error(
        'macOS Speech helper is unavailable on this host. Select another speech model.'
      )
    }
  }

  cancel(): void {
    this.chunks = []
    this.samples = 0
    this.abortController.abort()
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    if (this.abortController.signal.aborted) {
      return
    }
    const normalized = resampleToRate(samples, sampleRate, 16000)
    this.samples += normalized.length
    if (this.samples > 16000 * 60 * 10) {
      throw new Error('macOS speech recognition is limited to 10 minutes per dictation')
    }
    this.chunks.push(new Float32Array(normalized))
  }

  async finish(): Promise<string> {
    if (!this.chunks.length) {
      return ''
    }
    const chunks = this.chunks
    this.chunks = []
    const directory = await mkdtemp(path.join(tmpdir(), 'orca-speech-'))
    try {
      const audioPath = path.join(directory, 'dictation.wav')
      await writeFile(audioPath, encodePcm16Wav(chunks, 16000), { mode: 0o600 })
      if (this.abortController.signal.aborted) {
        return ''
      }
      const transcript = await runMacosSpeech([audioPath], 55_000, this.abortController.signal)
      return this.abortController.signal.aborted ? '' : transcript
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
