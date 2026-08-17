import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import { writeStartupCommandWhenShellReady } from './local-pty-shell-ready-startup-command'

type DataCb = (data: string) => void
type ExitCb = (info: { exitCode: number }) => void

function createMockProc(): pty.IPty & {
  _emitData: (data: string) => void
  _writes: string[]
} {
  let onDataCbs: DataCb[] = []
  const writes: string[] = []
  const fake = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'bash',
    handleFlowControl: false,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    clear: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: DataCb) => {
      onDataCbs.push(cb)
      return {
        dispose: () => {
          onDataCbs = onDataCbs.filter((c) => c !== cb)
        }
      }
    },
    onExit: (_cb: ExitCb) => ({ dispose: () => {} }),
    _emitData: (data: string) => {
      for (const cb of onDataCbs.slice()) {
        cb(data)
      }
    },
    _writes: writes
  } as unknown as pty.IPty & { _emitData: (data: string) => void; _writes: string[] }

  return fake
}

describe('writeStartupCommandWhenShellReady', () => {
  let origPlatform: NodeJS.Platform

  beforeEach(() => {
    vi.useFakeTimers()
    origPlatform = process.platform
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  it('appends LF on POSIX so bash/zsh submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('appends CR on Windows so PowerShell/cmd.exe submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    proc._emitData('\r\nPS> ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\r'])
  })

  it('does not re-append a submit byte if the command already ends in CR or LF', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude\n', () => {})

    await ready
    proc._emitData('\r\nPS> ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('keeps the no-prompt fallback conservative to avoid duplicate shell echo', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(150)
    await Promise.resolve()

    expect(proc._writes).toEqual(['codex\n'])
  })

  it('uses the short settle delay when marker scan already observed post-marker bytes', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve({ postMarkerBytesObserved: true })
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(29)
    await Promise.resolve()
    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(proc._writes).toEqual(['codex\n'])
  })

  // Why: multiline startup commands must be bracketed-paste wrapped (ESC[200~ … ESC[201~) so shells insert them literally instead of treating each LF as Enter.
  it('wraps a multiline startup command in bracketed paste when the shell supports it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    const command = "claude '--dangerously-skip-permissions' 'line one\nline two'"
    writeStartupCommandWhenShellReady(ready, proc, command, () => {}, {
      bracketedPasteSafe: true
    })

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual([`\x1b[200~${command}\x1b[201~\n`])
  })

  it('leaves a single-line command on the raw submit path even when bracketed paste is safe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {}, {
      bracketedPasteSafe: true
    })

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('does not bracket-wrap a multiline command when the shell lacks bracketed paste', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    const command = 'echo one\necho two'
    // Why: bracketedPasteSafe defaults false, so keep the raw path to avoid echoing ESC[200~ on shells without bracketed paste.
    writeStartupCommandWhenShellReady(ready, proc, command, () => {})

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual([`${command}\n`])
  })
})
