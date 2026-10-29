import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  createDaemonShutdownDeadline,
  DAEMON_SHUTDOWN_TIMEOUT_MS
} from './daemon-shutdown-deadline'
import { TerminalHost } from './terminal-host'

const ROOT_PID = 424_242

// The force-kill sweep is still waiting on slow process-table reads when the deadline fires.
function createSubprocessWithSlowSweep(): SubprocessHandle {
  return {
    pid: ROOT_PID,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => {},
    terminateOwnedTree: () => 'unavailable',
    forceKill: () => new Promise<void>(() => {}),
    signal: () => {},
    onData: () => {},
    onExit: () => {},
    dispose: () => {}
  }
}

describe.skipIf(process.platform === 'win32')('daemon shutdown deadline', () => {
  let host: TerminalHost
  let exit: ReturnType<typeof vi.fn<() => void>>
  let cancelDeadline: () => void

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    host = new TerminalHost({ spawnSubprocess: createSubprocessWithSlowSweep })
    await host.createOrAttach({
      sessionId: 'slow-sweep',
      cols: 80,
      rows: 24,
      streamClient: { onData: () => {}, onExit: () => {} }
    })
    exit = vi.fn<() => void>()
    const deadline = createDaemonShutdownDeadline(
      { log: () => {}, close: () => {} },
      () => host,
      exit
    )
    cancelDeadline = deadline.cancel
    deadline.start()
  })

  afterEach(() => {
    cancelDeadline()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('SIGKILLs the PTY process group before exiting while the async sweep is still pending', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    void host.dispose()

    await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)

    expect(kill.mock.calls).toEqual([[-ROOT_PID, 'SIGKILL']])
    expect(exit).toHaveBeenCalledOnce()
  })

  it.each(['ESRCH', 'EPERM'])(
    'falls back to the root pid when the group kill fails with %s',
    async (code) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (Number(pid) < 0) {
          throw Object.assign(new Error('group kill refused'), { code })
        }
        return true
      })
      void host.dispose()

      await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)

      expect(kill.mock.calls).toEqual([
        [-ROOT_PID, 'SIGKILL'],
        [ROOT_PID, 'SIGKILL']
      ])
      expect(exit).toHaveBeenCalledOnce()
    }
  )
})
