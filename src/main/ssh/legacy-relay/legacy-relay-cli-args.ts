/**
 * Reads the argv an older relay forwards for one `orca` command run in its terminal.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { CLI_BOOLEAN_FLAGS } from '../../../shared/cli-argument-boundary'
import {
  isOrchestrationRetryRequestId,
  RETRY_REQUEST_ID_GUIDANCE
} from '../../../shared/orchestration-retry-request-id'

export type LegacyRelayCliArgs = { command: string; flags: Map<string, string | boolean> }

export function parseLegacyRelayCliArgs(argv: readonly string[]): LegacyRelayCliArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const assignment = token.slice(2)
    const equals = assignment.indexOf('=')
    if (equals !== -1) {
      flags.set(assignment.slice(0, equals), assignment.slice(equals + 1))
      continue
    }
    const next = argv[i + 1]
    if (!CLI_BOOLEAN_FLAGS.has(assignment) && next !== undefined && !next.startsWith('--')) {
      flags.set(assignment, next)
      i += 1
    } else {
      flags.set(assignment, true)
    }
  }
  return { command: commandPath.join(' '), flags }
}

/** A valued flag the shell emptied parses as `true`; dropping it would change the command. */
export function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  if (value === true) {
    throw new Error(`--${name} requires a value; it was passed with none.`)
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function numberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for --${name}`)
  }
  return parsed
}

/** A damaged `--retry-request` must fail: a fresh identity would re-apply the mutation (#15180). */
export function retryRequestFlag(flags: Map<string, string | boolean>): string | undefined {
  const value = flags.get('retry-request')
  if (value === undefined) {
    return undefined
  }
  // Even an explicit empty value is damage, never "no retry".
  if (!isOrchestrationRetryRequestId(value)) {
    throw new Error(RETRY_REQUEST_ID_GUIDANCE)
  }
  return value
}

/** `--payload`, or the structured flags the worker preamble uses instead of raw JSON. */
export function messagePayload(flags: Map<string, string | boolean>): string | undefined {
  const raw = stringFlag(flags, 'payload')
  const fields = {
    taskId: stringFlag(flags, 'task-id'),
    dispatchId: stringFlag(flags, 'dispatch-id'),
    outcome: stringFlag(flags, 'outcome'),
    reportPath: stringFlag(flags, 'report-path'),
    phase: stringFlag(flags, 'phase')
  }
  const filesModified = stringFlag(flags, 'files-modified')
  const structured = Object.values(fields).some(Boolean) || filesModified !== undefined
  if (!structured) {
    return raw
  }
  if (raw !== undefined) {
    throw new Error('Use either --payload or structured payload flags, not both.')
  }
  if (fields.outcome && fields.outcome !== 'succeeded' && fields.outcome !== 'failed') {
    throw new Error('Invalid --outcome. Expected succeeded or failed.')
  }
  return JSON.stringify({
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
    ...(filesModified
      ? {
          filesModified: filesModified
            .split(',')
            .map((file) => file.trim())
            .filter(Boolean)
        }
      : {})
  })
}
