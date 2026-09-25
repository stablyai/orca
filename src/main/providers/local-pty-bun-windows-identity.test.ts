import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ptyProcesses, ptyShellName } from './local-pty-provider-state'
import {
  confirmLocalPtyShellForeground,
  inspectLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import { getLocalPtyCwd, sendLocalPtySignal } from './local-pty-session-operations'

const { confirm, cwd, membership } = vi.hoisted(() => ({
  confirm: vi.fn(),
  cwd: vi.fn(),
  membership: vi.fn()
}))
vi.mock('./agent-foreground-process', () => ({
  confirmShellForegroundProcess: confirm,
  resolveAgentForegroundProcessWithAvailability: vi.fn()
}))
vi.mock('./process-cwd', () => ({ resolveProcessCwd: cwd }))
vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: membership,
  isWindowsPtyJobReadable: () => true
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  confirm.mockResolvedValue(true)
  cwd.mockResolvedValue('C:\\work')
})
afterEach(() => {
  ptyProcesses.clear()
  ptyShellName.clear()
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
})

describe('Bun in-process Windows shell identity', () => {
  it('uses the child shell for cwd and foreground checks while signaling the owned job', async () => {
    const proc = {
      pid: 1200,
      shellProcessId: 1201,
      jobRootProcessIsWrapper: true as const,
      processNameIsSpawnFile: true as const,
      process: 'cmd.exe',
      cols: 80,
      rows: 24,
      handleFlowControl: false,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      clear() {},
      pause() {},
      resume() {},
      resize() {},
      kill() {},
      signalProcess: vi.fn()
    }
    ptyProcesses.set('gated-shell', proc)
    ptyShellName.set('gated-shell', 'cmd.exe')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await getLocalPtyCwd('gated-shell')).toBe('C:\\work')
    expect(cwd).toHaveBeenCalledWith(1201)
    expect(await confirmLocalPtyShellForeground('gated-shell')).toBe(true)
    expect(confirm).toHaveBeenCalledWith(1201, 'cmd.exe', expect.any(Object))
    await sendLocalPtySignal('gated-shell', 'SIGTERM')
    expect(proc.signalProcess).toHaveBeenCalledWith('SIGTERM')
    expect(kill).not.toHaveBeenCalled()
    membership.mockReturnValue(new Set([1201]))
    expect(inspectLocalPtyChildProcesses('gated-shell')).toBe('no-children')
    membership.mockReturnValue(new Set([1201, 1202]))
    expect(inspectLocalPtyChildProcesses('gated-shell')).toBe('children')
    membership.mockReturnValue(null)
    expect(inspectLocalPtyChildProcesses('gated-shell')).toBe('unverifiable')
    Reflect.deleteProperty(proc, 'shellProcessId')
    cwd.mockClear()
    expect(await getLocalPtyCwd('gated-shell')).toBe('')
    expect(cwd).not.toHaveBeenCalled()
  })
})
