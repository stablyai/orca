import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../agent-transcript-pane-test-harness'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import { failOnLaunchedAgentExit, type LaunchedAgentExitRuntime } from './launched-agent-exit-watch'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Raw bytes from zsh under Orca's wrapper in a PTY.
const ZSH_PROMPT = '\x1b]133;A\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jplain% \x1b[K\x1b[?2004h'
const ZSH_RUNS_LAUNCH_LINE =
  "c\x08cursor-agent '--model' 'not-a-model'\x1b[?2004l\r\r\n\x1b]133;C\x07"
const REJECTION = 'Cannot use this model: not-a-model. Available models: auto, gpt-5.3\r\n'
const ZSH_PROMPT_AFTER_EXIT = [
  `\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${' '.repeat(79)}\r \r`,
  '\x1b]133;D;1\x07\x1b]133;A\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jplain% \x1b[K',
  '\x1b]777;orca-shell-ready\x07\x1b[?2004h'
].join('')
const NESTED_SHELL_COMMAND = '\x1b]133;C\x07ls\n\x1b]133;D;0\x07'

/** Past every re-read the watch makes after a shell return. */
async function runRereads(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000)
}

function watchedLaunch(options: {
  foreground?: () => LaunchedAgentForeground | Promise<LaunchedAgentForeground>
  replay?: string
}) {
  let listener: (data: string) => void = () => {}
  let recent = options.replay ?? ''
  const unsubscribe = vi.fn()
  const runtime: LaunchedAgentExitRuntime = {
    readLaunchedAgentForeground: vi.fn(async () => (options.foreground ?? (() => 'shell'))()),
    subscribeToTerminalData: (_ptyId, next) => {
      listener = next
      return unsubscribe
    },
    readRecentTerminalOutput: () => recent
  }
  let finishWait: (value: string) => void = () => {}
  let waitSignal: AbortSignal | undefined
  const settled = vi.fn()
  const result = failOnLaunchedAgentExit(runtime, 'pty-1', 'cursor', undefined, (signal) => {
    waitSignal = signal
    return new Promise<string>((resolve) => {
      finishWait = resolve
    })
  })
  void result.then(settled, settled)
  return {
    runtime,
    result,
    settled,
    unsubscribe,
    waitSignal: () => waitSignal,
    finishWait: (value: string) => finishWait(value),
    setRecent: (value: string) => {
      recent = value
    },
    emit: (data: string) => {
      recent += data
      listener(data)
    }
  }
}

describe('a launched agent exiting during readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails with what the launch command printed', async () => {
    const launch = watchedLaunch({})
    launch.emit(ZSH_PROMPT)
    launch.emit(ZSH_RUNS_LAUNCH_LINE)
    launch.emit(REJECTION)
    launch.emit(ZSH_PROMPT_AFTER_EXIT)
    await runRereads()

    await expect(launch.result).rejects.toThrow(
      `The agent's launch command exited before the agent was ready. Its output:\n${REJECTION.trim()}`
    )
    expect(launch.waitSignal()?.aborted).toBe(true)
    expect(launch.unsubscribe).toHaveBeenCalledOnce()
  })

  it('finds an exit that happened before the wait began', async () => {
    const launch = watchedLaunch({
      replay: ZSH_PROMPT + ZSH_RUNS_LAUNCH_LINE + REJECTION + ZSH_PROMPT_AFTER_EXIT
    })
    await runRereads()

    await expect(launch.result).rejects.toThrow(REJECTION.trim())
  })

  it('says so when the launch command printed nothing', async () => {
    const launch = watchedLaunch({ replay: ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT })
    await runRereads()

    await expect(launch.result).rejects.toThrow('without printing anything')
  })

  it('keeps what a verbose launch printed last after its start left the buffer', async () => {
    const launch = watchedLaunch({})
    launch.emit(ZSH_RUNS_LAUNCH_LINE)
    launch.setRecent(REJECTION)
    launch.emit(ZSH_PROMPT_AFTER_EXIT)
    await runRereads()

    await expect(launch.result).rejects.toThrow(REJECTION.trim())
  })

  it('reads a redrawn line as its last frame, over CRLF', async () => {
    const launch = watchedLaunch({
      replay: `${ZSH_RUNS_LAUNCH_LINE}loading 10%\rloading 90%\r\nfatal: bad model\r\n${ZSH_PROMPT_AFTER_EXIT}`
    })
    await runRereads()

    await expect(launch.result).rejects.toThrow(/Its output:\nloading 90%\nfatal: bad model$/)
  })

  it('keeps a last line with no newline, which zsh’s prompt redraw would erase', async () => {
    const launch = watchedLaunch({
      replay: `${ZSH_RUNS_LAUNCH_LINE}fatal: bad model${ZSH_PROMPT_AFTER_EXIT}`
    })
    await runRereads()

    await expect(launch.result).rejects.toThrow(/Its output:\nfatal: bad model$/)
  })

  it('reads again while a prompt’s own command leads the group', async () => {
    const reads: LaunchedAgentForeground[] = ['agent', 'unknown', 'shell']
    const launch = watchedLaunch({ foreground: () => reads.shift() ?? 'agent' })
    launch.emit(ZSH_RUNS_LAUNCH_LINE + REJECTION + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()

    await expect(launch.result).rejects.toThrow(REJECTION.trim())
  })

  it('stops reading once the shell’s return never proves out', async () => {
    const launch = watchedLaunch({ foreground: () => 'agent' })
    launch.emit(ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()
    const reads = vi.mocked(launch.runtime.readLaunchedAgentForeground).mock.calls.length
    await runRereads()

    expect(vi.mocked(launch.runtime.readLaunchedAgentForeground)).toHaveBeenCalledTimes(reads)
    expect(launch.settled).not.toHaveBeenCalled()
  })

  it('leaves a slow start alone while the shell runs the launch line', async () => {
    const launch = watchedLaunch({})
    // An rc file toggling bracketed paste looks like a command ending without integration marks.
    launch.emit('\x1b[?2004l\x1b[?2004h')
    launch.emit(ZSH_PROMPT)
    launch.emit(ZSH_RUNS_LAUNCH_LINE)
    await runRereads()

    expect(launch.runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
    launch.finishWait('ready')
    await expect(launch.result).resolves.toBe('ready')
  })

  it('ignores a finish no command came before, as prompt hooks can report', async () => {
    const launch = watchedLaunch({})
    launch.emit('\x1b]133;D;0\x07')
    await runRereads()

    expect(launch.runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
    expect(launch.settled).not.toHaveBeenCalled()
  })

  it('outlasts a shell nested in the agent, then still sees the agent exit', async () => {
    let foreground: LaunchedAgentForeground = 'agent'
    const launch = watchedLaunch({ foreground: () => foreground })
    launch.emit(ZSH_RUNS_LAUNCH_LINE)
    launch.emit(NESTED_SHELL_COMMAND)
    await runRereads()
    expect(launch.settled).not.toHaveBeenCalled()

    foreground = 'shell'
    launch.emit(REJECTION + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()

    await expect(launch.result).rejects.toThrow(REJECTION.trim())
  })

  it('keeps waiting when no foreground read can tell', async () => {
    const launch = watchedLaunch({ foreground: () => 'unknown' })
    launch.emit(ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()

    expect(launch.settled).not.toHaveBeenCalled()
    launch.finishWait('ready')
    await expect(launch.result).resolves.toBe('ready')
  })

  it('discards a read that a later command outran', async () => {
    let answer: (value: LaunchedAgentForeground) => void = () => {}
    const launch = watchedLaunch({
      foreground: () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    launch.emit(ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()
    launch.emit(ZSH_RUNS_LAUNCH_LINE)
    answer('shell')
    await runRereads()

    expect(launch.settled).not.toHaveBeenCalled()
  })

  it('keeps a ready answer when the exit verdict lands after it', async () => {
    let answer: (value: LaunchedAgentForeground) => void = () => {}
    const launch = watchedLaunch({
      foreground: () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    launch.emit(ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT)
    await runRereads()
    launch.finishWait('ready')
    await runRereads()
    answer('shell')

    await expect(launch.result).resolves.toBe('ready')
  })
})

describe('worker readiness on a real runtime pane', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // cursor waits on tui-idle, opencode on its composer marker, claude on the first of both.
  it.each(['cursor', 'opencode', 'claude'] as const)(
    '%s: a rejected launch fails on the shell’s report, not at the deadline',
    async (agent) => {
      const { runtime, handle, terminal } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'zsh',
        launchAgent: agent,
        data: ''
      })
      vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('shell')
      vi.useFakeTimers()
      const wait = waitForWorkerAgentReady(runtime, handle, {
        agent,
        reusesTerminal: false,
        creation: terminal,
        timeoutMs: 60_000
      }).catch((error: unknown) => error)

      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ZSH_PROMPT + ZSH_RUNS_LAUNCH_LINE, 1)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, REJECTION + ZSH_PROMPT_AFTER_EXIT, 2)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(await wait).toMatchObject({ message: expect.stringContaining(REJECTION.trim()) })
    }
  )

  it('does not watch a reused terminal, whose shell ran commands before this start', async () => {
    const { runtime, handle, terminal } = await createTranscriptPane({
      paneTitle: 'shell',
      foregroundProcess: 'zsh',
      launchAgent: 'cursor',
      data: ''
    })
    const read = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('shell')
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ZSH_RUNS_LAUNCH_LINE + ZSH_PROMPT_AFTER_EXIT, 1)
    vi.useFakeTimers()
    const wait = waitForWorkerAgentReady(runtime, handle, {
      agent: 'cursor',
      reusesTerminal: true,
      creation: terminal,
      timeoutMs: 50
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await wait

    expect(read).not.toHaveBeenCalled()
  })
})
