import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'

/** Full (bounded) output of a failed agent-CLI generation run, kept for
 *  on-demand display only — never persisted or synced. */
export type AgentGenerationFailureOutput = {
  label: string
  exitCode: number | null
  stdout: string
  stderr: string
}

// Why: bounding both ends keeps a runaway 4 MiB capture out of memory and IPC
// while preserving where CLIs put their errors (some front-load them, some
// print them last).
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
  // Why: V8 otherwise retains the multi-megabyte parent through sliced strings
  // stored in the capture map; this no-op replacement materializes a flat copy.
  return bounded.replace(/$/u, '')
}

/** Renders the capture as one copyable text block: a header line, then the
 *  streams that had content. */
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

// Why: the block renders in a <pre> and gets pasted into bug reports; ANSI and
// non-printing control/format characters (incl. bidi overrides) must not
// survive, but line structure must.
function sanitizeStreamForDisplay(value: string): string {
  return stripAnsiControlSequences(value.replace(/\r\n?/g, '\n'))
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\t' ? character : ''
    )
    .trim()
}
