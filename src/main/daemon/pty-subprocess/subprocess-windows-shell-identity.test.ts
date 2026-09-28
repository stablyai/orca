import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalProcess } from '../../../shared/terminal-process'
import { Session } from '../session'
import { resolveTerminalHostSessionCwd } from '../terminal-host-session-cwd'
import { createDaemonPtySubprocessHandle } from './subprocess-handle'

const { cwd, confirm, membership } = vi.hoisted(() => ({
  cwd: vi.fn(),
  confirm: vi.fn(),
  membership: vi.fn()
}))
vi.mock('../../providers/process-cwd', () => ({ resolveProcessCwd: cwd }))
vi.mock('../../providers/agent-foreground-process', () => ({
  confirmShellForegroundProcess: confirm,
  resolveAgentForegroundProcessWithAvailability: vi.fn()
}))
vi.mock('../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: membership,
  isWindowsPtyJobReadable: () => true
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe('daemon gated Windows shell identity', () => {
  it('resolves the child shell cwd without changing the owned process root', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    cwd.mockResolvedValue('C:\\work')
    let exit: (event: { exitCode: number }) => void = () => {}
    const proc: TerminalProcess & {
      shellProcessId?: number
      jobRootProcessIsWrapper: true
      signalProcess: ReturnType<typeof vi.fn>
    } = {
      pid: 999_999_999,
      shellProcessId: 999_999_998,
      jobRootProcessIsWrapper: true,
      signalProcess: vi.fn(),
      process: 'cmd.exe',
      cols: 80,
      rows: 24,
      clear: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: () => ({ dispose() {} }),
      onExit: (listener) => {
        exit = listener
        return { dispose() {} }
      }
    }
    const subprocess = createDaemonPtySubprocessHandle({
      process: proc,
      shellPath: 'cmd.exe',
      spawnCwd: '',
      env: {},
      startupCommandDeliveredInShellArgs: false,
      reportsChildExitStatus: true,
      sessionId: 'gated-shell',
      startupAgentRecognition: null
    })
    const session = new Session({
      sessionId: 'gated-shell',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false
    })
    try {
      expect(session.pid).toBe(999_999_999)
      expect(await resolveTerminalHostSessionCwd(session)).toBe('C:\\work')
      expect(cwd).toHaveBeenCalledWith(999_999_998)
      confirm.mockResolvedValue(true)
      expect(await subprocess.confirmShellForeground?.()).toBe(true)
      expect(confirm).toHaveBeenCalledWith(999_999_998, 'cmd.exe', expect.any(Object))
      const kill = vi.spyOn(process, 'kill')
      subprocess.signal('SIGTERM')
      expect(proc.signalProcess).toHaveBeenCalledWith('SIGTERM')
      expect(kill).not.toHaveBeenCalled()
      membership.mockReturnValue(new Set([999_999_998]))
      expect(session.inspectChildProcesses()).toBe('no-children')
      membership.mockReturnValue(new Set([999_999_998, 999_999_997]))
      expect(session.inspectChildProcesses()).toBe('children')
      membership.mockReturnValue(null)
      expect(session.inspectChildProcesses()).toBe('unverifiable')
      delete proc.shellProcessId
      cwd.mockClear()
      expect(await resolveTerminalHostSessionCwd(session)).toBeNull()
      expect(cwd).not.toHaveBeenCalled()
    } finally {
      exit({ exitCode: 0 })
      session.dispose()
    }
  })
})
