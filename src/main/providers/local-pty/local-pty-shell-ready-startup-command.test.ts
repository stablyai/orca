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
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the no-prompt fallback conservative to avoid duplicate shell echo', async () => {
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(150)
    await Promise.resolve()

    expect(proc._writes).toEqual(['codex\r'])
  })

  it('uses the short settle delay when marker scan already observed post-marker bytes', async () => {
    const proc = createMockProc()
    const ready = Promise.resolve({ postMarkerBytesObserved: true })
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(29)
    await Promise.resolve()
    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(proc._writes).toEqual(['codex\r'])
  })

  // Bracketed paste inserts multiline prompts literally instead of submitting each LF.
  it('wraps a multiline startup command in bracketed paste when the shell supports it', async () => {
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

    expect(proc._writes).toEqual([`\x1b[200~${command}\x1b[201~\r`])
  })

  it('does not bracket-wrap a multiline command when the shell lacks bracketed paste', async () => {
    const proc = createMockProc()
    const ready = Promise.resolve()
    const command = 'echo one\necho two'
    // Unsupported shells need raw CR submissions; bracketed-paste escapes would be echoed literally.
    writeStartupCommandWhenShellReady(ready, proc, command, () => {})

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['echo one\recho two\r'])
  })
})
