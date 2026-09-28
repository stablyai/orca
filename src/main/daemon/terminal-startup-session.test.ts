import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { TerminalStartupSession } from './terminal-startup-session'
import { Session } from './session'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'

function ownership() {
  const pending = new Map<string, TerminalStartupSession>()
  const onExit = vi.fn()
  const attempt = new TerminalStartupSession(
    'attempt',
    pending,
    (subprocess, notify, synchronous) =>
      new Session({
        sessionId: 'attempt',
        cols: 80,
        rows: 24,
        subprocess,
        shellReadySupported: false,
        requireSynchronousOutput: synchronous,
        onExit: notify
      }),
    onExit
  )
  return { attempt, pending, onExit }
}

it('discards failed-shell output before constructing the fallback session', async () => {
  const { attempt, pending, onExit } = ownership()
  const first = createMockSubprocess()
  attempt.prepare(() => first, true)
  first._simulateData('\x1b[?2004hPRIMARY')
  await attempt.discard()
  expect(pending.size).toBe(0)
  expect(onExit).not.toHaveBeenCalled()
  const fallback = createMockSubprocess()
  const session = attempt.prepare(() => fallback, true)
  fallback._simulateData('FALLBACK')
  const onData = vi.fn()
  session.attachClient({ onData, onExit: vi.fn() }, true)
  expect(onData.mock.calls[0]?.[0]).toBe('FALLBACK')
  expect(session.getSnapshot()?.modes.bracketedPaste).toBe(false)
  await attempt.discard()
})

it('retains a failed native cleanup and retries it before another attempt', async () => {
  const { attempt, pending } = ownership()
  const discardNative = vi
    .fn()
    .mockRejectedValueOnce(new Error('still live'))
    .mockResolvedValue(undefined)
  expect(() =>
    attempt.prepare(
      () => {
        throw new Error('handle failed')
      },
      true,
      discardNative
    )
  ).toThrow('handle failed')
  await expect(attempt.discard()).rejects.toThrow('still live')
  expect(pending.get('attempt')).toBe(attempt)
  await attempt.clearPreviousAttempt()
  expect(discardNative).toHaveBeenCalledTimes(2)
  expect(pending.size).toBe(0)
})

it('cleans up Session parser resources when listener installation fails', () => {
  const handle = createMockSubprocess()
  handle.onData = () => {
    throw new Error('subscribe failed')
  }
  const timers = vi.getTimerCount
  vi.useFakeTimers()
  try {
    const before = timers()
    expect(
      () =>
        new Session({
          sessionId: 'failed',
          cols: 80,
          rows: 24,
          subprocess: handle,
          shellReadySupported: true
        })
    ).toThrow('subscribe failed')
    expect(timers()).toBe(before)
  } finally {
    vi.useRealTimers()
  }
})
