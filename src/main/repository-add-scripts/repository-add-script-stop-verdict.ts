import type { ProcessResult, ProcessTerminationBarrier } from '@orca/process-host/process-spec'
import type { RepositoryAddScriptExecutionResult } from '../../shared/repository-add-script-types'
import { HOOK_TIMEOUT } from '../hooks'

// Two streams plus the note must fit the service's 16384-character cap so neither is dropped.
const MAX_STREAM_CHARACTERS = 8000
const MAY_STILL_RUN = 'The script could not be confirmed stopped and may still be running.'
const STOPPED = 'Script was stopped before it finished.'

export type StreamResult = Pick<ProcessResult, 'code' | 'stdout' | 'stderr' | 'timedOut'> & {
  signal?: NodeJS.Signals | null
  outputTruncated?: boolean
}

export type TrackedTermination<T extends ProcessTerminationBarrier = ProcessTerminationBarrier> = {
  barrier: T
  proven: () => boolean
  attempted: () => boolean
}

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_STREAM_CHARACTERS
    ? { text: text.slice(0, MAX_STREAM_CHARACTERS), truncated: true }
    : { text, truncated: false }
}

/**
 * Records whether the barrier ever proved the tree gone, using the same rule as process-host:
 * on Windows either attempt counts, elsewhere only the forced one.
 */
export function trackTermination<T extends ProcessTerminationBarrier>(
  barrier: T,
  platform: NodeJS.Platform
): TrackedTermination<T> {
  let attempted = false
  let signalProven = false
  let forceProven = false
  const tracked: T = {
    ...barrier,
    signal: async (child, signal) => {
      attempted = true
      signalProven = (await barrier.signal(child, signal)) === true
      return signalProven
    },
    force: async (child) => {
      attempted = true
      forceProven = (await barrier.force(child)) === true
      return forceProven
    }
  }
  return {
    barrier: tracked,
    proven: () => forceProven || (platform === 'win32' && signalProven),
    attempted: () => attempted
  }
}

// Only a normally observed, unaborted exit counts; a timeout, signal or abort never yields a code.
function summarize(
  result: StreamResult,
  termination: TrackedTermination,
  aborted: boolean
): RepositoryAddScriptExecutionResult {
  const stdout = clip(result.stdout)
  const stderr = clip(result.stderr)
  const parts = [stdout.text, stderr.text].filter((part) => part.length > 0)
  // Any stop that was attempted but never proven leaves possibly-live work, whatever triggered it.
  const unverifiable = (result.timedOut || termination.attempted()) && !termination.proven()
  if (result.timedOut) {
    parts.push(`Script timed out after ${HOOK_TIMEOUT}ms.`)
  } else if (aborted) {
    parts.push(STOPPED)
  } else if (typeof result.code !== 'number') {
    parts.push('Script was terminated without reporting an exit code.')
  }
  if (unverifiable) {
    parts.push(MAY_STILL_RUN)
  }
  const exited = !aborted && !result.timedOut && !result.signal && typeof result.code === 'number'
  return {
    ...(exited ? { exitCode: result.code ?? undefined } : {}),
    ...(unverifiable ? { processVerdict: 'unverifiable' as const } : {}),
    output: parts.join('\n'),
    outputTruncated: result.outputTruncated === true || stdout.truncated || stderr.truncated
  }
}

// A rejection after a stop attempt that was never proven still leaves possibly-live work.
export async function summarizeSpawn(
  spawn: Promise<StreamResult>,
  termination: TrackedTermination,
  signal: AbortSignal | undefined
): Promise<RepositoryAddScriptExecutionResult> {
  try {
    return summarize(await spawn, termination, signal?.aborted === true)
  } catch (error) {
    if (termination.attempted() && !termination.proven()) {
      return { processVerdict: 'unverifiable', output: MAY_STILL_RUN, outputTruncated: false }
    }
    // A proven stop after an abort ended the script; it is not a launch failure.
    if (termination.attempted() && signal?.aborted) {
      return { output: STOPPED, outputTruncated: false }
    }
    throw error
  }
}
