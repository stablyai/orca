import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../session'
import type { SubprocessHandle } from '../session-subprocess-handle'

function createSession() {
  const resizes: [number, number][] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only these members.
  const handle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground: vi.fn(async () => false),
    write: () => {},
    resize: (cols: number, rows: number) => resizes.push([cols, rows]),
    pause: () => {},
    resume: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    terminateOwnedTree: () => 'unavailable' as const,
    onData() {},
    onExit() {},
    dispose: () => {}
  } as unknown as SubprocessHandle
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only the options given here.
  const session = new Session({
    sessionId: 'repaint',
    cols: 80,
    rows: 24,
    subprocess: handle,
    shellReadySupported: false
  } as never)
  return { session, resizes }
}

describe.skipIf(process.platform === 'win32')('session repaint request', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resizes only the PTY one row smaller and back, once at a time', async () => {
    vi.useFakeTimers()
    const { session, resizes } = createSession()
    session.requestRepaint()
    session.requestRepaint()
    expect(session.getAppliedSize()).toEqual({ cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [80, 23],
      [80, 24]
    ])
  })

  it('lets a real resize own the grid, even back to the same size', async () => {
    vi.useFakeTimers()
    const { session, resizes } = createSession()
    session.requestRepaint()
    session.resize(80, 24)
    session.requestRepaint()
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [80, 23],
      [80, 24],
      [80, 23],
      [80, 24]
    ])
  })

  it('never undoes a real resize to another size', async () => {
    vi.useFakeTimers()
    const { session, resizes } = createSession()
    session.requestRepaint()
    session.resize(100, 30)
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [80, 23],
      [100, 30]
    ])
  })
})
