import { clampOrchestrationAskTimeoutMs } from '../shared/orchestration-ask-timeout'
import {
  isSafeTimerDelayMs,
  parsePositiveSafeIntegerNumericText,
  parsePositiveSafeIntegerText
} from '../shared/timer-delay'

// Why: the host bridges the full Orca CLI over the relay (#7716), so mutation
// commands (worktree create, orchestration dispatch, Linear writes, ...) can
// legitimately outlive the relay's 30 s default request timeout. Long-poll
// commands carry their waiter budget in --timeout-ms; extend past it so the
// host-side CLI produces its proper timeout error instead of the relay
// cutting the request short.
const REMOTE_CLI_DEFAULT_TIMEOUT_MS = 5 * 60_000
const REMOTE_CLI_WAIT_TIMEOUT_MS = 10 * 60_000
const REMOTE_CLI_TIMEOUT_GRACE_MS = 60_000
const ORCHESTRATION_ASK_RELAY_GRACE_MS = 3 * 60_000
const ORCHESTRATION_ASK_RELAY_BASE_MS = 11 * 60_000

const REMOTE_TIMEOUT_BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'current',
  'full',
  'help',
  'inject',
  'json',
  'relations',
  'unread',
  'wait'
])

export function remoteCliRequestTimeoutMs(params: Record<string, unknown>): number | undefined {
  const argv = getStringArgv(params)
  if (!argv) {
    return undefined
  }
  const commandPath = parseRemoteCommandPath(argv)
  const timeoutFlag = findLastTimeoutMsFlag(argv)
  if (commandPath[0] === 'orchestration' && commandPath[1] === 'ask') {
    const parsed =
      timeoutFlag?.raw === undefined ? null : parsePositiveSafeIntegerText(timeoutFlag.raw)
    const effective = clampOrchestrationAskTimeoutMs(parsed ?? undefined)
    return Math.max(ORCHESTRATION_ASK_RELAY_BASE_MS, effective + ORCHESTRATION_ASK_RELAY_GRACE_MS)
  }
  const base = isWaitStyleCliRequest(argv, commandPath)
    ? REMOTE_CLI_WAIT_TIMEOUT_MS
    : REMOTE_CLI_DEFAULT_TIMEOUT_MS
  const explicit =
    timeoutFlag?.raw === undefined ? null : parsePositiveSafeIntegerNumericText(timeoutFlag.raw)
  // Why: the relay forwards this straight into a timer, so a budget that would
  // overflow the timer range after grace has to degrade to the base budget.
  const extended = explicit === null ? null : explicit + REMOTE_CLI_TIMEOUT_GRACE_MS
  if (extended !== null && isSafeTimerDelayMs(extended)) {
    return Math.max(base, extended)
  }
  return base
}

function isWaitStyleCliRequest(argv: string[], commandPath: string[]): boolean {
  if (argv.includes('--wait')) {
    return true
  }
  return (
    (commandPath[0] === 'terminal' && commandPath[1] === 'wait') ||
    (commandPath[0] === 'orchestration' && commandPath[1] === 'ask')
  )
}

function findLastTimeoutMsFlag(argv: string[]): { raw: string | undefined } | null {
  let result: { raw: string | undefined } | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--timeout-ms') {
      const next = argv[index + 1]
      result = { raw: next?.startsWith('--') ? undefined : next }
    } else if (token.startsWith('--timeout-ms=')) {
      result = { raw: token.slice('--timeout-ms='.length) }
    }
  }
  return result
}

function getStringArgv(params: Record<string, unknown>): string[] | null {
  const argv = params.argv
  if (!Array.isArray(argv) || !argv.every((part) => typeof part === 'string')) {
    return null
  }
  return argv
}

function parseRemoteCommandPath(argv: string[]): string[] {
  const commandPath: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const assignment = token.slice(2)
    if (assignment.includes('=')) {
      continue
    }

    const next = argv[index + 1]
    if (!REMOTE_TIMEOUT_BOOLEAN_FLAGS.has(assignment) && next && !next.startsWith('--')) {
      index += 1
    }
  }
  return commandPath
}
