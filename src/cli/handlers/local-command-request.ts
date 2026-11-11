import { RuntimeClientError } from '../runtime/types'
import {
  LOCAL_COMMAND_APPROVAL_WINDOW_MS,
  LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC,
  LOCAL_COMMAND_ERRORS,
  LOCAL_COMMAND_MAX_TIMEOUT_SEC,
  LOCAL_COMMAND_RESULT_GRACE_MS,
  LOCAL_COMMANDS_REQUEST_METHOD,
  LOCAL_COMMANDS_STATUS_METHOD,
  type LocalCommandRequestParams,
  type LocalCommandRequestResult,
  type LocalCommandStatusResult
} from '../../shared/local-commands/local-command-contract'

const POLL_MS = 1000

export type LocalCommandCliDeps = {
  call: <T>(method: string, params: unknown) => Promise<T>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type LocalCommandInput = {
  command: string
  cwd?: string
  timeoutSec?: number
  reason?: string
}

/** Asks, then waits for the person and the run: the approval window plus the command's own timeout. */
export async function requestLocalCommand(
  input: LocalCommandInput,
  deps: LocalCommandCliDeps
): Promise<LocalCommandStatusResult> {
  const params: LocalCommandRequestParams = {
    command: input.command,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {})
  }
  let created: LocalCommandRequestResult
  try {
    created = await deps.call<LocalCommandRequestResult>(LOCAL_COMMANDS_REQUEST_METHOD, params)
  } catch (error) {
    throw explainLocalCommandError(error)
  }
  const timeoutMs = (input.timeoutSec ?? LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC) * 1000
  // orcad settles every request by itself (expired / lost); this bound only guards a vanished orcad.
  const deadline =
    deps.now() + LOCAL_COMMAND_APPROVAL_WINDOW_MS + timeoutMs + 2 * LOCAL_COMMAND_RESULT_GRACE_MS
  for (;;) {
    const current = await deps.call<LocalCommandStatusResult>(LOCAL_COMMANDS_STATUS_METHOD, {
      requestId: created.requestId
    })
    if ((current.status !== 'pending' && current.status !== 'running') || deps.now() >= deadline) {
      return current
    }
    await deps.sleep(POLL_MS)
  }
}

/** What the agent reads back. Output is the person's computer's, quoted as-is. */
export function formatLocalCommandOutcome(outcome: LocalCommandStatusResult): {
  text: string
  isError: boolean
} {
  switch (outcome.status) {
    case 'finished': {
      const result = outcome.result
      if (!result) {
        return { text: 'The command finished but no result came back.', isError: true }
      }
      const lines = [
        result.timedOut
          ? `Timed out after ${Math.round(result.durationMs / 1000)}s and was stopped.`
          : result.signal
            ? `Stopped by ${result.signal}.`
            : `Exit code ${result.exitCode ?? 'unknown'}.`
      ]
      if (result.stdout) {
        lines.push('', 'stdout:', result.stdout)
      }
      if (result.stderr) {
        lines.push('', 'stderr:', result.stderr)
      }
      if (result.truncated) {
        lines.push('', 'Output was cut at 128 KB per stream.')
      }
      return {
        text: lines.join('\n'),
        isError: result.timedOut || result.exitCode !== 0
      }
    }
    case 'declined':
      return {
        text:
          outcome.declineReason === 'denied'
            ? 'The person denied this command. Do not retry it; ask them what to do instead.'
            : outcome.declineReason === 'not_allowed'
              ? "This person's computer does not allow local commands from this workspace."
              : 'Nobody answered the request in time. Ask the person before trying again.',
        isError: true
      }
    case 'expired':
      return {
        text: 'Nobody answered the request in time. Ask the person before trying again.',
        isError: true
      }
    case 'failed':
      return {
        text: `The command could not start: ${outcome.message ?? 'unknown error'}`,
        isError: true
      }
    case 'lost':
      return {
        text: "The command started but its result never came back (the person's computer may have gone offline). It may or may not have finished.",
        isError: true
      }
    case 'pending':
    case 'running':
      return { text: 'Still waiting for the command. It may still run.', isError: true }
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  [LOCAL_COMMAND_ERRORS.noDesktop]:
    'No Orca app with local commands turned on is connected to this workspace. The person can turn it on in Orca: Settings → Orca Cloud → Commands on this computer. Commands run only while their Orca app is open.',
  [LOCAL_COMMAND_ERRORS.tooManyPending]:
    'Three local commands are already waiting or running. Wait for one to finish.',
  [LOCAL_COMMAND_ERRORS.rateLimited]:
    'This workspace asked for 60 local commands in the last hour. Try again later.',
  [LOCAL_COMMAND_ERRORS.unavailable]: 'Local commands work only inside an Orca Cloud workspace.',
  [LOCAL_COMMAND_ERRORS.forbidden]: 'Only an agent in this workspace can ask for a local command.'
}

export function explainLocalCommandError(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  const explained = ERROR_MESSAGES[error.message]
  if (explained) {
    return new RuntimeClientError(error.message, explained)
  }
  if (/hidden_characters/.test(error.message)) {
    return new RuntimeClientError(
      'invalid_argument',
      'The command contains control or invisible characters, which are never run. Use plain text.'
    )
  }
  if (/too_many_lines/.test(error.message)) {
    return new RuntimeClientError(
      'invalid_argument',
      'The command has more than 20 lines. Ask for something shorter, or a script the person can read.'
    )
  }
  if (/cwd_not_absolute/.test(error.message)) {
    return new RuntimeClientError(
      'invalid_argument',
      "cwd must be an absolute path on the person's computer, or start with ~."
    )
  }
  return error
}

export function parseLocalCommandTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const seconds = Number(value)
  if (!/^\d+$/.test(value) || seconds < 1 || seconds > LOCAL_COMMAND_MAX_TIMEOUT_SEC) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--timeout takes 1-${LOCAL_COMMAND_MAX_TIMEOUT_SEC} seconds`
    )
  }
  return seconds
}
