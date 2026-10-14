import { runProcess } from '@orca/process-host'
import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'

/**
 * Runs one shell command for the voice coordinator and returns a compact, model-facing
 * result. Execution goes through the repo's single child-process entry point
 * (`runProcess` — timeout tree-kill, output caps, exit-code-as-data all built in), never
 * a bare `child_process`. The command is a free-form string because the model writes
 * shell; POSIX runs it under `/bin/sh -c`, Windows under `cmd.exe /d /v:off /s /c` with
 * the line encoded by the shared `quoteWindowsCmdArgument` (percent-breaking, backslash
 * doubling, `""` quotes — a hand-rolled quoting here misses all three).
 *
 * Acknowledged tradeoff (docs/reference/windows-edr-posture.md): `cmd.exe /c` carrying
 * caret-escaped free text is the shape obfuscated-command-line detectors score. For a
 * shell tool the free text IS the request, so the line is inherent; what we control is
 * using the canonical encoder and adding no further interpreter hops.
 */

export type VoiceCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

/** Voice turns are seconds-scale; a command that outlives this is reported, not awaited. */
const COMMAND_TIMEOUT_MS = 15_000
/** The model reads the result aloud-able context; keep it small, keep the tail. */
const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024

export async function runVoiceCommand(options: {
  command: string
  cwd: string
  signal?: AbortSignal
}): Promise<VoiceCommandResult> {
  const command = options.command.trim()
  if (/[\r\n]/.test(command)) {
    // A voice-typed command is one line; a newline means a mangled transcript, not a
    // script. The redirect matters: the live failure was the model burning five turns
    // fighting heredoc quoting to write a file — work that belongs to an agent.
    return {
      exitCode: null,
      stdout: '',
      stderr:
        'multi-line commands are not supported — run_command is for single-line checks. Writing files or multi-step work goes to an agent: use message_agent.',
      timedOut: false,
      truncated: false
    }
  }
  const spec =
    process.platform === 'win32'
      ? {
          program: process.env.ComSpec ?? 'cmd.exe',
          args: ['/d', '/v:off', '/s', '/c', quoteWindowsCmdArgument(command)],
          windowsVerbatimArguments: true as const
        }
      : { program: '/bin/sh', args: ['-c', command] }
  const result = await runProcess(
    {
      ...spec,
      cwd: options.cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
      killOnOutputLimit: true,
      // Voice commands can spawn trees (npm, watch modes); never leave orphans behind.
      terminationBarrier: true,
      ...(options.signal ? { signal: options.signal } : {})
    },
    'tail'
  )
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated: result.outputTruncated === true
  }
}

/** Model-facing rendering: compact, tail-biased, honest about timeout/truncation. */
export function formatVoiceCommandOutput(result: VoiceCommandResult): string {
  const parts: string[] = []
  if (result.timedOut) {
    parts.push(
      `The command did not finish within ${COMMAND_TIMEOUT_MS / 1000} seconds and was stopped.`
    )
  }
  if (result.truncated) {
    parts.push('Output was truncated; this is the end of it.')
  }
  if (result.stdout.trim()) {
    parts.push(result.stdout.trim())
  }
  if (result.stderr.trim()) {
    parts.push(`stderr: ${result.stderr.trim()}`)
  }
  if (parts.length === 0) {
    parts.push('The command produced no output.')
  }
  parts.push(`exit code: ${result.exitCode ?? 'none'}`)
  return parts.join('\n')
}
