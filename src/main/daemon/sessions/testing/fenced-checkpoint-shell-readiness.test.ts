import { expect, it, onTestFinished, vi } from 'vitest'
import { createMockSubprocess } from '../../pty-subprocess/testing/fake-restart-subprocess'
import { takeTerminalHostPendingOutput } from '../../terminal-host/terminal-host-session-inspection-operations'
import { Session } from '../session'

it('releases startup input when readiness finishes after a fenced checkpoint', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const subprocess = createMockSubprocess()
  const session = new Session({
    sessionId: 'restart-candidate',
    cols: 80,
    rows: 24,
    subprocess,
    shellReadySupported: true
  })
  onTestFinished(() => session.dispose())
  session.writeStartupCommand('codex resume fixture\r')
  subprocess._simulateData('\x1b]777;orca-shell')

  expect(
    takeTerminalHostPendingOutput(session, true, {
      expectedIncarnationId: session.incarnationId,
      teardownSnapshot: true
    })?.incarnationId
  ).toBe(session.incarnationId)

  subprocess._simulateData('-ready\x07% ')
  await vi.advanceTimersByTimeAsync(50)
  expect(subprocess.write.mock.calls).toEqual([['codex resume fixture\r']])
})
