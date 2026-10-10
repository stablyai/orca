import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { PreparedSessionHistorySeed, SessionOutputPlane } from './session-output-plane'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const options = { cols: 80, rows: 24, scrollback: 1000 }

async function prepare(chunks: readonly string[]) {
  return PreparedSessionHistorySeed.create({ ...options, historySeedChunks: chunks }, () => {})
}

describe('prepared session history', () => {
  it.each([
    ['empty list', []],
    ['empty chunks', ['', '']],
    ['split escapes', ['\x1b[31', 'mRED\x1b[0m\r\n\x1b]2;RESTORED', '\x07\x1b7', 'saved\x1b8']],
    ['surrogate budget boundary', [`${'x'.repeat(65535)}🦀\r\nLAST`]],
    ['split surrogate chunks', ['FIRST\r\n\ud83e', '\udd80\r\nLAST']],
    ['alternate buffer and modes', ['NORMAL\r\n\x1b[?1049hALT\x1b[?2004h\x1b[>3u']]
  ])('matches synchronous seed state for %s', async (_name, historySeedChunks) => {
    const previous = new SessionOutputPlane({ ...options, historySeedChunks })
    const seed = await prepare(historySeedChunks)
    const prepared = new SessionOutputPlane({ ...options, preparedHistorySeed: seed })
    try {
      expect(prepared.historySeeded).toBe(previous.historySeeded)
      expect(prepared.getSnapshot()).toEqual(previous.getSnapshot())
    } finally {
      previous.disposeEmulator()
      prepared.disposeEmulator()
      seed.dispose()
    }
  })

  it('preserves visible Unicode, title and input modes across a yielded seed', async () => {
    const seed = await prepare([`${'x'.repeat(65535)}🦀\r\n\x1b]2;RESTORED\x07\x1b[?2004hLAST`])
    const output = new SessionOutputPlane({ ...options, preparedHistorySeed: seed })
    try {
      const snapshot = output.getSnapshot()
      expect(snapshot?.snapshotAnsi).toContain('🦀\r\nLAST')
      expect(snapshot?.lastTitle).toBe('RESTORED')
      expect(snapshot?.modes.bracketedPaste).toBe(true)
    } finally {
      output.disposeEmulator()
    }
  })

  it('keeps failed empty writes and short-circuit failure semantics', async () => {
    const write = vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockReturnValue(false)
    const seed = await prepare(['', 'unreached'])
    const output = new SessionOutputPlane({ ...options, preparedHistorySeed: seed })
    expect(output.historySeeded).toBe(false)
    expect(write).toHaveBeenCalledExactlyOnceWith('')
    output.disposeEmulator()
  })

  it('disposes replay state when parsing throws', async () => {
    vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementation(() => {
      throw new Error('parser failed')
    })
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    await expect(prepare(['unreadable'])).rejects.toThrow('parser failed')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes unadopted history exactly once and rejects another adoption', async () => {
    const seed = await prepare(['LAST'])
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    seed.dispose()
    seed.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => seed.adopt()).toThrow('no longer owned')
  })

  it('transfers ownership once without disposing the live output plane', async () => {
    const seed = await prepare(['LAST'])
    const output = new SessionOutputPlane({ ...options, preparedHistorySeed: seed })
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    seed.dispose()
    expect(dispose).not.toHaveBeenCalled()
    expect(() => seed.adopt()).toThrow('no longer owned')
    expect(output.getSnapshot()?.snapshotAnsi).toContain('LAST')
    output.disposeEmulator()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('discards torn prompt output without emission if exit subscription throws', async () => {
    vi.useFakeTimers()
    const seed = await prepare(['LAST'])
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    const emit = vi.spyOn(SessionOutputPlane.prototype, 'emit')
    const subprocess: SubprocessHandle = {
      pid: 4242,
      write() {},
      resize() {},
      kill() {},
      forceKill() {},
      signal() {},
      terminateOwnedTree: () => 'unavailable',
      getForegroundProcess: () => null,
      onData(listener) {
        listener('\x1b]10;?')
      },
      onExit() {
        throw new Error('exit listener failed')
      },
      dispose() {}
    }
    expect(
      () =>
        new Session({
          ...options,
          sessionId: 'torn-prompt',
          subprocess,
          shellReadySupported: true,
          preparedHistorySeed: seed,
          startupIngress: { colors: {}, kittyKeyboardProtocol: true, deadlineMs: 1000 }
        })
    ).toThrow('exit listener failed')
    expect(emit).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes adopted history and startup timers if session construction fails', async () => {
    vi.useFakeTimers()
    const seed = await prepare(['LAST'])
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    const subprocess: SubprocessHandle = {
      pid: 4242,
      write() {},
      resize() {},
      kill() {},
      forceKill() {},
      signal() {},
      terminateOwnedTree: () => 'unavailable',
      getForegroundProcess: () => null,
      onData() {
        throw new Error('listener failed')
      },
      onExit() {},
      dispose() {}
    }
    expect(
      () =>
        new Session({
          ...options,
          sessionId: 'failed',
          subprocess,
          shellReadySupported: true,
          preparedHistorySeed: seed,
          startupIngress: { colors: {}, kittyKeyboardProtocol: true, deadlineMs: 1000 }
        })
    ).toThrow('listener failed')
    seed.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
