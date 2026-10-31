import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import { readFile, access } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { MacosSpeechSession, prepareMacosSpeech } from './macos-speech-session'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
beforeEach(() => {
  vi.spyOn(os, 'release').mockReturnValue('25.0.0')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('macOS speech session', () => {
  it('rejects unsupported hosts', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(() => new MacosSpeechSession()).toThrow('only available on macOS')
  })

  it('rejects older macOS before spawning the helper', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(os, 'release').mockReturnValue('24.6.0')
    expect(() => new MacosSpeechSession()).toThrow('macOS 26 or newer')
  })

  it('shares in-flight OS asset installation and allows retry after failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(runProcess).mockRejectedValueOnce(new Error('Asset installation failed'))
    const first = prepareMacosSpeech()
    expect(prepareMacosSpeech()).toBe(first)
    await expect(first).rejects.toThrow('Asset installation failed')
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await expect(prepareMacosSpeech()).resolves.toBeUndefined()
  })

  it('refuses a missing helper before recording or preparing language assets', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    expect(() => new MacosSpeechSession()).toThrow('helper is unavailable')
    await expect(prepareMacosSpeech()).rejects.toThrow('helper is unavailable')
  })

  it('accepts more than one minute of audio but bounds buffered recording to ten minutes', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const session = new MacosSpeechSession()
    expect(() => session.feedAudio(new Float32Array(16000 * 61), 16000)).not.toThrow()
    expect(() => session.feedAudio(new Float32Array(16000 * 540), 16000)).toThrow('10 minutes')
  })

  it('resamples recorded audio and removes the private WAV after recognition', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let file = ''
    vi.mocked(runProcess).mockImplementation(async (spec) => {
      file = String(spec.args?.[0])
      const wav = await readFile(file)
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(24)).toBe(16000)
      expect(wav.readUInt32LE(40)).toBe(16000 * 2)
      expect(spec.program).toMatch(/orca-speech$/)
      return { code: 0, signal: null, stdout: 'hello\n', stderr: '', timedOut: false }
    })
    const session = new MacosSpeechSession()
    session.feedAudio(new Float32Array(48000), 48000)
    expect(await session.finish()).toBe('hello')
    await expect(access(file)).rejects.toThrow()
  })

  it('removes recorded audio and surfaces permission failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let file = ''
    vi.mocked(runProcess).mockImplementation(async (spec) => {
      file = String(spec.args?.[0])
      return { code: 1, signal: null, stdout: '', stderr: 'Permission denied', timedOut: false }
    })
    const session = new MacosSpeechSession()
    session.feedAudio(new Float32Array(160), 16000)
    await expect(session.finish()).rejects.toThrow('Permission denied')
    await expect(access(file)).rejects.toThrow()
  })

  it('discards buffered and subsequent audio when canceled', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(runProcess).mockClear()
    const session = new MacosSpeechSession()
    session.feedAudio(new Float32Array(160), 16000)
    session.cancel()
    session.feedAudio(new Float32Array(160), 16000)
    expect(await session.finish()).toBe('')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('aborts recognition on discard, suppresses its result, and removes the WAV', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const session = new MacosSpeechSession()
    let file = ''
    vi.mocked(runProcess).mockImplementation(async (spec) => {
      file = String(spec.args?.[0])
      await access(file)
      expect(spec.signal?.aborted).toBe(false)
      session.cancel()
      expect(spec.signal?.aborted).toBe(true)
      return { code: 0, signal: null, stdout: 'discarded text', stderr: '', timedOut: false }
    })
    session.feedAudio(new Float32Array(160), 16000)
    expect(await session.finish()).toBe('')
    await expect(access(file)).rejects.toThrow()
  })
})
