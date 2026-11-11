import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchLaunchComposer, type FreshComposerPtyHost } from './launch-composer-watch'
import type { LaunchedAgentExitRuntime } from './launched-agent-exit-watch'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// zsh under Orca's wrapper: the launch line starts (133;C), the agent exits, the prompt returns (133;D).
const LAUNCH_STARTED = "claude '--resume' 'abc'\x1b[?2004l\r\r\n\x1b]133;C\x07"
const NO_CONVERSATION = 'No conversation found with session ID: abc\r\n'
const SHELL_BACK = '\x1b]133;D;1\x07\x1b]133;A\x07\rplain% \x1b]777;orca-shell-ready\x07\x1b[?2004h'

/** A pane whose composer never appears; only its bytes and foreground change. */
function pane() {
  let listener: (data: string) => void = () => {}
  let recent = ''
  const host: FreshComposerPtyHost = {
    readiness: {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'bash',
      subscribeToData: () => () => {},
      readRecentOutput: () => undefined,
      write: () => {}
    },
    readHold: () => null,
    readForeground: async () => 'shell'
  }
  const exitRuntime: LaunchedAgentExitRuntime = {
    readLaunchedAgentForeground: vi.fn(async () => 'shell' as const),
    subscribeToTerminalData: (_ptyId, next) => {
      listener = next
      return () => {}
    },
    readRecentTerminalOutput: () => recent
  }
  return {
    host,
    exitRuntime,
    emit: (data: string) => {
      recent += data
      listener(data)
    }
  }
}

describe('the launch composer hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets sends through as soon as the launched agent exits to its shell, not after the full wait', async () => {
    const { host, exitRuntime, emit } = pane()
    const watches = new Map<string, Promise<boolean>>()
    watchLaunchComposer(watches, host, 'pty-1', 'claude', exitRuntime)
    const watch = watches.get('pty-1')!
    const settled = vi.fn()
    void watch.then(settled)
    emit(LAUNCH_STARTED)
    emit(NO_CONVERSATION)
    emit(SHELL_BACK)
    // Well under Claude's 8 s composer wait: the shell-return re-reads only.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(settled).toHaveBeenCalledWith(true)
  })

  it('still refuses when the composer never comes and the agent never exits', async () => {
    const { host, exitRuntime } = pane()
    exitRuntime.readLaunchedAgentForeground = vi.fn(async () => 'agent' as const)
    const watches = new Map<string, Promise<boolean>>()
    watchLaunchComposer(watches, host, 'pty-1', 'claude', exitRuntime)
    const watch = watches.get('pty-1')!
    await vi.runAllTimersAsync()
    await expect(watch).resolves.toBe(false)
  })

  it('without the exit watch, the same pane is still held at that point (the old 8 s refusal)', async () => {
    const { host, emit } = pane()
    const watches = new Map<string, Promise<boolean>>()
    watchLaunchComposer(watches, host, 'pty-1', 'claude')
    const settled = vi.fn()
    void watches.get('pty-1')!.then(settled)
    emit(LAUNCH_STARTED)
    emit(NO_CONVERSATION)
    emit(SHELL_BACK)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(settled).not.toHaveBeenCalled()
  })
})
