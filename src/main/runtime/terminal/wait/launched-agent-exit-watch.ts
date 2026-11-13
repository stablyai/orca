import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal/output/terminal-osc133-command-finished'
import { terminalSafe } from '../../../../shared/terminal/output/terminal-safe-text'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { applyTerminalLineControls } from '../output/tail/terminal-tail-line-controls'

const COMMAND_STARTED_MARK = '\x1b]133;C'
const COMMAND_FINISHED_MARK = '\x1b]133;D'
const LAUNCH_OUTPUT_MAX_CHARS = 2_000
// What zsh prints before each prompt so it starts on a clean line: its end-of-line mark, and a redraw that erases
// the last line for a terminal that would keep it. Its mark is reverse video and the redraw ends right at the finish.
// eslint-disable-next-line no-control-regex -- the mark's escapes and the redraw's returns are what identify them.
const ZSH_PROMPT_SP = /\x1b\[7m[%#]\x1b\[27m| *\r *\r$/g
// The finish fires before the prompt draws, whose commands (a git status, starship) lead the group until it has.
const SHELL_RETURN_READ_DELAYS_MS = [
  FOREGROUND_COMMAND_READS.settleMs,
  ...FOREGROUND_COMMAND_READS.retryDelaysMs
]

export type LaunchedAgentExitRuntime = Pick<
  OrcaRuntimeService,
  'readLaunchedAgentForeground' | 'subscribeToTerminalData' | 'readRecentTerminalOutput'
>

/** What the launch command printed, from the shell's last finished command in the pane's recent bytes.
 * A PTY that died mid-command never finished it, so its output runs to the end. */
export function readLaunchCommandOutput(
  recentOutput: string,
  { ptyExited = false }: { ptyExited?: boolean } = {}
): string {
  const lastFinished = recentOutput.lastIndexOf(COMMAND_FINISHED_MARK)
  const finished =
    ptyExited && recentOutput.lastIndexOf(COMMAND_STARTED_MARK) >= lastFinished
      ? recentOutput.length
      : lastFinished
  if (finished === -1) {
    return ''
  }
  // A launch that printed past the buffer's limit has lost its start, not the end that names the error.
  const started = Math.max(0, recentOutput.lastIndexOf(COMMAND_STARTED_MARK, finished))
  return recentOutput
    .slice(started, finished)
    .replace(ZSH_PROMPT_SP, '')
    .split(/\r*\n/)
    .map((line) => terminalSafe(applyTerminalLineControls(line).text).trim())
    .filter(Boolean)
    .join('\n')
    .slice(-LAUNCH_OUTPUT_MAX_CHARS)
}

export function launchedAgentExitMessage(output: string): string {
  return output
    ? `The agent's launch command exited before the agent was ready. Its output:\n${output}`
    : "The agent's launch command exited before the agent was ready, without printing anything."
}

export class LaunchedAgentExitedError extends Error {}

function launchedAgentExitError(recentOutput: string | undefined): Error {
  return new LaunchedAgentExitedError(
    launchedAgentExitMessage(readLaunchCommandOutput(recentOutput ?? ''))
  )
}

/** Fails a fresh launch's readiness wait once its launch command has finished and the shell is back in front.
 * Neither proves it alone: a shell nested in the agent leaks OSC 133;D, and the shell also leads until the agent starts.
 * Panes without shell integration, or that cannot prove a shell, wait as long as they did without this. */
export function failOnLaunchedAgentExit<T>(
  runtime: LaunchedAgentExitRuntime,
  ptyId: string,
  agent: TuiAgent,
  signal: AbortSignal | undefined,
  wait: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const stop = new AbortController()
  let unsubscribe = (): void => {}
  return new Promise<T>((resolve, reject) => {
    let commandStarted = false
    // Moves on every start and finish: only the latest shell return may decide.
    let marks = 0
    const checkForExit = async (): Promise<void> => {
      const mark = marks
      for (const delayMs of SHELL_RETURN_READ_DELAYS_MS) {
        await new Promise((next) => setTimeout(next, delayMs))
        if (stop.signal.aborted || mark !== marks) {
          return
        }
        const foreground = await runtime.readLaunchedAgentForeground(ptyId, agent)
        if (foreground === 'shell' && mark === marks) {
          reject(launchedAgentExitError(runtime.readRecentTerminalOutput(ptyId)))
          return
        }
      }
    }
    const scanner = createOsc133CommandFinishedScanner(
      () => {
        // Prompt hooks can report a finish before any command began.
        if (commandStarted) {
          marks += 1
          // A failed read proves nothing; the wait goes on.
          void checkForExit().catch(() => {})
        }
      },
      () => {
        commandStarted = true
        marks += 1
      }
    )
    unsubscribe = runtime.subscribeToTerminalData(ptyId, scanner.scan)
    wait(signal ? AbortSignal.any([signal, stop.signal]) : stop.signal).then(resolve, reject)
    // The launch can have ended before this wait began.
    const replay = runtime.readRecentTerminalOutput(ptyId)
    if (replay) {
      scanner.scan(replay)
    }
  }).finally(() => {
    unsubscribe()
    stop.abort()
  })
}
