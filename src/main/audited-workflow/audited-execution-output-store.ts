// Bounded, on-disk storage for an execution run's stdout/stderr.
//
// Agent output is the highest-risk field for embedded secrets and absolute
// paths, so SQLite stores only counters and this module returns only counters.
// It NEVER returns content, and no path it computes is projected to the
// renderer — Phase 4 deliberately ships no "view output" affordance.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'

// Same head/tail split as captureAgentGenerationFailureOutput: bounding both
// ends preserves where CLIs put their errors (some front-load, some print last).
const STREAM_HEAD_LIMIT = 16 * 1024
const STREAM_TAIL_LIMIT = 48 * 1024

// The hard live cap. Exceeding it kills the tree and blocks the run with
// `output_too_large` rather than letting a runaway agent fill the disk.
export const MAX_EXECUTION_OUTPUT_BYTES = 4 * 1024 * 1024

export type ExecutionOutputWriteResult = {
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
}

export function boundExecutionStream(value: string): { text: string; truncated: boolean } {
  if (value.length <= STREAM_HEAD_LIMIT + STREAM_TAIL_LIMIT) {
    return { text: value, truncated: false }
  }
  const omitted = value.length - STREAM_HEAD_LIMIT - STREAM_TAIL_LIMIT
  const head = value.slice(0, STREAM_HEAD_LIMIT)
  const tail = value.slice(value.length - STREAM_TAIL_LIMIT)
  return { text: `${head}\n… (${omitted} characters omitted) …\n${tail}`, truncated: true }
}

/** Whether a stream has any non-whitespace content, matching agent-failure-output.ts. */
export function hasMeaningfulOutput(value: string): boolean {
  return /\S/.test(value)
}

export function getExecutionRunLogDir(userDataPath: string, runId: string): string {
  return join(userDataPath, 'audited-workflow', 'runs', runId)
}

/**
 * Writes bounded, ANSI-stripped logs and returns counters only.
 *
 * A write failure is swallowed deliberately: logs are diagnostic, and losing
 * them must never change a run's recorded outcome or block its finalization.
 * The byte counts still describe what the process actually produced.
 */
export function writeExecutionOutput(
  userDataPath: string,
  runId: string,
  stdout: string,
  stderr: string
): ExecutionOutputWriteResult {
  const boundedOut = boundExecutionStream(stripAnsiControlSequences(stdout))
  const boundedErr = boundExecutionStream(stripAnsiControlSequences(stderr))

  try {
    const dir = getExecutionRunLogDir(userDataPath, runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stdout.log'), boundedOut.text, 'utf8')
    writeFileSync(join(dir, 'stderr.log'), boundedErr.text, 'utf8')
  } catch (error) {
    console.error('[auditedWorkflow] Writing execution logs failed:', error)
  }

  return {
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    outputTruncated: boundedOut.truncated || boundedErr.truncated
  }
}
