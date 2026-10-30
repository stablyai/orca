import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'

/** Bounded failure output is display-on-demand only; never persist or sync it. */
export type AgentGenerationFailureOutput = {
  label: string
  exitCode: number | null
  stdout: string
  stderr: string
}

// Keep both ends because CLIs print errors at either end; exclude runaway multi-MB captures from memory/IPC.
const STREAM_HEAD_LIMIT = 16 * 1024
const STREAM_TAIL_LIMIT = 48 * 1024

export function captureAgentGenerationFailureOutput(
  label: string,
  exitCode: number | null,
  stdout: string,
  stderr: string
): AgentGenerationFailureOutput | null {
  if (!/\S/.test(stdout) && !/\S/.test(stderr)) {
    return null
  }
  return {
    label,
    exitCode,
    stdout: boundStream(stdout),
    stderr: boundStream(stderr)
  }
}

function boundStream(value: string): string {
  if (value.length <= STREAM_HEAD_LIMIT + STREAM_TAIL_LIMIT) {
    return value
  }
  const omitted = value.length - STREAM_HEAD_LIMIT - STREAM_TAIL_LIMIT
  const bounded = `${value.slice(0, STREAM_HEAD_LIMIT)}\n… (${omitted} characters omitted) …\n${value.slice(
    value.length - STREAM_TAIL_LIMIT
  )}`
  // Materialize a flat string so V8 cannot retain the multi-MB parent through a slice.
  return bounded.replace(/$/u, '')
}

export function formatAgentGenerationFailureOutputForDisplay(
  output: AgentGenerationFailureOutput
): string {
  const sections = [`${output.label} exited with code ${output.exitCode ?? 'unknown'}.`]
  const stderr = sanitizeStreamForDisplay(output.stderr)
  if (stderr) {
    sections.push(`[stderr]\n${stderr}`)
  }
  const stdout = sanitizeStreamForDisplay(output.stdout)
  if (stdout) {
    sections.push(`[stdout]\n${stdout}`)
  }
  return sections.join('\n\n')
}

// Copyable preformatted output must retain lines but exclude ANSI/control/bidi formatting.
function sanitizeStreamForDisplay(value: string): string {
  return stripAnsiControlSequences(value.replace(/\r\n?/g, '\n'))
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\t' ? character : ''
    )
    .trim()
}
