import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { isMacosTahoeOrNewer } from '../window/macos-tahoe-release'

/**
 * Runs the real Swift helper. Everything above it is unit-tested against a
 * fake, which cannot catch a drift in the helper's own CLI or event shape —
 * only a real run does.
 *
 * Skipped unless this is a macOS 26+ box that has already built the helper
 * (`pnpm run build:speech-transcriber-macos`), so CI and Linux stay unaffected.
 */
const HELPER_PATH = join(
  import.meta.dirname,
  '../../../native/speech-transcriber-macos/.build/release/orca-speech-transcriber'
)
const canRun = process.platform === 'darwin' && isMacosTahoeOrNewer() && existsSync(HELPER_PATH)
const SPOKEN_PHRASE = 'The quick brown fox jumps over the lazy dog.'

vi.mock('./apple-speech-helper-binary', () => ({
  getAppleSpeechHelperPath: () => HELPER_PATH
}))

const workDirs: string[] = []

afterAll(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The locale the helper picked, which is the one it will transcribe in. */
async function readHelperLocale(): Promise<string> {
  const result = await runProcess({ program: HELPER_PATH, args: ['status'], timeoutMs: 15_000 })
  for (const line of result.stdout.split('\n')) {
    try {
      const event: unknown = JSON.parse(line)
      const locale = event && typeof event === 'object' ? Reflect.get(event, 'locale') : null
      if (typeof locale === 'string') {
        return locale
      }
    } catch {
      continue
    }
  }
  return ''
}

/** Synthesizes the phrase with `say` and returns it as the mono float32 a mic would deliver. */
async function speakToFloat32(phrase: string): Promise<Float32Array> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-apple-speech-contract-'))
  workDirs.push(dir)
  const aiff = join(dir, 'phrase.aiff')
  const wav = join(dir, 'phrase.wav')
  await runProcess({ program: '/usr/bin/say', args: ['-o', aiff, phrase], timeoutMs: 30_000 })
  await runProcess({
    program: '/usr/bin/afconvert',
    args: ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav],
    timeoutMs: 30_000
  })

  const file = readFileSync(wav)
  const dataStart = file.indexOf('data', 12, 'ascii') + 8
  const frames = (file.length - dataStart) / 2
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = file.readInt16LE(dataStart + index * 2) / 32768
  }
  return samples
}

const describeWithHelper = canRun ? describe : describe.skip

describeWithHelper('orca-speech-transcriber', () => {
  it('answers the status query with an arm the model states understand', async () => {
    const { readAppleSpeechAssetStatus } = await import('./apple-speech-assets')

    expect(['installed', 'downloading', 'supported', 'unsupported']).toContain(
      await readAppleSpeechAssetStatus()
    )
  })

  it('transcribes real speech into partial and final segments', async () => {
    const { readAppleSpeechAssetStatus } = await import('./apple-speech-assets')
    // Why both gates: the helper transcribes in the Mac's own dictation
    // language, and `say` speaks in its own default voice, so an English
    // phrase is only a fair assertion on an English Mac.
    if ((await readAppleSpeechAssetStatus()) !== 'installed') {
      return
    }
    if (!(await readHelperLocale()).toLowerCase().startsWith('en')) {
      return
    }
    const { AppleSpeechSession } = await import('./apple-speech-session')
    const samples = await speakToFloat32(SPOKEN_PHRASE)
    const events: { type: string; text?: string }[] = []
    const session = new AppleSpeechSession((event) => events.push(event))

    await session.start()
    // Fed in 300ms slices, the way the renderer delivers captured audio.
    for (let offset = 0; offset < samples.length; offset += 4800) {
      session.feedAudio(samples.slice(offset, offset + 4800), 16000)
    }
    await session.finish()

    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.some((event) => event.type === 'partial')).toBe(true)
    const finals = events.filter((event) => event.type === 'final').map((event) => event.text ?? '')
    expect(finals.join(' ')).toMatch(/quick brown fox/i)
  }, 120_000)
})
