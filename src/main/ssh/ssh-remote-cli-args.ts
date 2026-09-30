import { CLI_BOOLEAN_FLAGS } from '../../shared/cli-argument-boundary'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import {
  isOrchestrationRetryRequestId,
  RETRY_REQUEST_ID_GUIDANCE,
  VALUELESS_RETRY_REQUEST_GUIDANCE
} from '../../shared/orchestration-retry-request-id'

const REPEATED_FLAG_SEPARATOR = '\u0000'
const REPEATABLE_REMOTE_STRING_FLAGS = new Set(['label'])

export function parseRemoteCliArgs(argv: string[]): ParsedRemoteCli {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const assignment = token.slice(2)
    // Why: the SSH relay-backed shim should accept values beginning with `--` via `--flag=value`.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      setRemoteFlag(flags, assignment.slice(0, equalsIndex), assignment.slice(equalsIndex + 1))
      continue
    }

    const flag = assignment
    const next = argv[i + 1]
    if (!isRemoteBooleanFlag(flag, commandPath) && next && !next.startsWith('--')) {
      setRemoteFlag(flags, flag, next)
      i += 1
    } else {
      setRemoteFlag(flags, flag, true)
    }
  }
  return { commandPath, flags }
}

export function resolveRemoteCliHandle(
  flags: Map<string, string | boolean>,
  env: Record<string, string>,
  flagName: string
): string {
  return optionalRemoteCliString(flags, flagName) ?? env.ORCA_TERMINAL_HANDLE ?? 'unknown'
}

export function requiredRemoteCliString(
  flags: Map<string, string | boolean>,
  name: string
): string {
  const value = optionalRemoteCliString(flags, name)
  if (!value) {
    throw new Error(`Missing --${name}`)
  }
  return value
}

export function optionalRemoteCliString(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The relay shim parses its own argv, so it cannot inherit the CLI's valued-flag guards. A
 * `--retry-request` the shell emptied parses as `true`, and letting that fall through to
 * `undefined` mints a fresh mutation identity and re-applies the mutation (#15180).
 */
export function readRemoteRetryRequestFlag(
  flags: Map<string, string | boolean>
): string | undefined {
  const value = flags.get('retry-request')
  if (value === undefined) {
    return undefined
  }
  if (value === true) {
    throw new RemoteCliArgumentError('invalid_argument', VALUELESS_RETRY_REQUEST_GUIDANCE)
  }
  if (!isOrchestrationRetryRequestId(value)) {
    throw new RemoteCliArgumentError('invalid_argument', RETRY_REQUEST_ID_GUIDANCE)
  }
  return value
}

export function optionalRemoteCliNumber(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = optionalRemoteCliString(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

function isRemoteBooleanFlag(flag: string, commandPath: string[]): boolean {
  // Why: Android launch already uses --activity <name>; only Linear issue reads use it as a boolean.
  return (
    CLI_BOOLEAN_FLAGS.has(flag) ||
    (flag === 'activity' && commandPath[0] === 'linear' && commandPath[1] === 'issue')
  )
}

function setRemoteFlag(
  flags: Map<string, string | boolean>,
  name: string,
  value: string | boolean
): void {
  const previous = flags.get(name)
  if (
    typeof previous === 'string' &&
    typeof value === 'string' &&
    REPEATABLE_REMOTE_STRING_FLAGS.has(name)
  ) {
    flags.set(name, `${previous}${REPEATED_FLAG_SEPARATOR}${value}`)
    return
  }
  flags.set(name, value)
}
