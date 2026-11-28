import type { AutomationPrecheck } from '../../shared/automations/automation-definition'
import {
  DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS
} from '../../shared/automations/launch/automation-precheck'
import { getOptionalPositiveIntegerFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

type PrecheckFlags = {
  command: string | null | undefined
  timeoutSeconds: number | undefined
}

export function readPrecheckFlags(flags: Map<string, string | boolean>): PrecheckFlags {
  const timeoutSeconds = getOptionalPositiveIntegerFlag(flags, 'precheck-timeout')
  if (timeoutSeconds !== undefined && timeoutSeconds > MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--precheck-timeout must be at most ${MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS} seconds`
    )
  }
  if (!flags.has('precheck')) {
    return { command: undefined, timeoutSeconds }
  }
  const value = flags.get('precheck')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', '--precheck requires a command')
  }
  return { command: value.trim() || null, timeoutSeconds }
}

/** A flag that was not passed keeps the saved value, so editing the command alone does not
 *  drop a timeout the automation was created with. */
export function resolvePrecheck(
  { command, timeoutSeconds }: PrecheckFlags,
  savedPrecheck: AutomationPrecheck | null
): AutomationPrecheck | null | undefined {
  if (command === undefined) {
    if (timeoutSeconds === undefined) {
      return undefined
    }
    if (!savedPrecheck) {
      throw new RuntimeClientError('invalid_argument', '--precheck-timeout requires --precheck')
    }
    return { command: savedPrecheck.command, timeoutSeconds }
  }
  if (!command) {
    return null
  }
  return {
    command,
    timeoutSeconds:
      timeoutSeconds ?? savedPrecheck?.timeoutSeconds ?? DEFAULT_AUTOMATION_PRECHECK_TIMEOUT_SECONDS
  }
}

export function getPrecheckFlag(
  flags: Map<string, string | boolean>
): AutomationPrecheck | null | undefined {
  return resolvePrecheck(readPrecheckFlags(flags), null)
}
