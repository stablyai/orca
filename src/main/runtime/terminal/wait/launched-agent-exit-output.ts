import { terminalSafe } from '../../../../shared/terminal/output/terminal-safe-text'
import { replaceDispatchCapabilities } from '../../orchestration/worker-terminal-redaction'
import { applyTerminalLineControls } from '../output/tail/terminal-tail-line-controls'

const COMMAND_STARTED_MARK = '\x1b]133;C'
const COMMAND_FINISHED_MARK = '\x1b]133;D'
const LAUNCH_OUTPUT_MAX_CHARS = 2_000
// eslint-disable-next-line no-control-regex -- zsh's end-of-line mark and prompt redraw are not launch output.
const ZSH_PROMPT_SP = /\x1b\[7m[%#]\x1b\[27m| *\r *\r$/g

/** The launch command is the outermost OSC 133;C that never finished. A later nested C is not that boundary. */
function outermostUnclosedStart(recentOutput: string): number {
  const open: number[] = []
  let from = 0
  while (from < recentOutput.length) {
    const started = recentOutput.indexOf(COMMAND_STARTED_MARK, from)
    const finished = recentOutput.indexOf(COMMAND_FINISHED_MARK, from)
    if (started === -1 && finished === -1) {
      break
    }
    if (started !== -1 && (finished === -1 || started < finished)) {
      open.push(started)
      from = started + COMMAND_STARTED_MARK.length
      continue
    }
    if (open.length > 0) {
      open.pop()
    }
    from = finished + COMMAND_FINISHED_MARK.length
  }
  return open[0] ?? -1
}

/** Retain the failed command's last screenful, including a PTY exit before its shell's finish marker. */
export function readLaunchedAgentExitOutput(
  recentOutput: string,
  options: { stopAtFinish?: boolean } = {}
): string {
  const { stopAtFinish = true } = options
  const lastStarted = recentOutput.lastIndexOf(COMMAND_STARTED_MARK)
  const outer = stopAtFinish ? lastStarted : outermostUnclosedStart(recentOutput)
  const started = Math.max(0, outer >= 0 ? outer : lastStarted)
  const finished = recentOutput.lastIndexOf(COMMAND_FINISHED_MARK)
  const lines = recentOutput
    .slice(started, stopAtFinish && finished > started ? finished : undefined)
    .replace(ZSH_PROMPT_SP, '')
    .split(/\r*\n/)
    .map((line) => terminalSafe(applyTerminalLineControls(line).text).trim())
    .filter(Boolean)
    .join('\n')
  // Redact before the cut: truncation can strip a token's dcap_ prefix and defeat the pattern.
  return replaceDispatchCapabilities(lines).value.slice(-LAUNCH_OUTPUT_MAX_CHARS)
}

export function retainLaunchedAgentExitOutput(
  pty: { lastExitOutput?: string } | undefined,
  buffer: { read: () => string } | undefined
): void {
  if (pty) {
    // A nested 133;C or 133;D is not the outer command's end, and a dead PTY never emits that.
    pty.lastExitOutput = readLaunchedAgentExitOutput(buffer?.read() ?? pty.lastExitOutput ?? '', {
      stopAtFinish: false
    })
  }
}
