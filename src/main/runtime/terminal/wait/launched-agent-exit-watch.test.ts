import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
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

/** Past every re-read the watch makes after a shell return. */
async function runRereads(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000)
}

function watchedLaunch(options: {
  foreground?: () => LaunchedAgentForeground | Promise<LaunchedAgentForeground>
  replay?: string
  alternateScreen?: boolean
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
    readRecentTerminalOutput: () => recent,
    readKnownTerminalAlternateScreen: () => options.alternateScreen
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

  it('seeds only live application markers from the existing screen context', async () => {
    const launch = watchedLaunch({ replay: ZSH_RUNS_LAUNCH_LINE, alternateScreen: true })
    launch.emit('\x1b]133;B\x07\x1b]133;C\x07answer\x1b]133;D;0\x07')
    await runRereads()
    expect(launch.settled).not.toHaveBeenCalled()
    launch.emit(`\x1b[?1049l${ZSH_PROMPT_AFTER_EXIT}`)
    await runRereads()
    await expect(launch.result).rejects.toThrow("The agent's launch command exited")
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
})
