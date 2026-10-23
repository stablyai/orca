import { AUTOMATION_CLOSE_ON_SUCCESS_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import type { AutomationUpdateInput } from '../../shared/automations-types'
import type { AutomationShowPayload } from '../automation-format'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

export function getCloseOnSuccessFlag(flags: Map<string, string | boolean>): boolean | undefined {
  const close = flags.get('close-on-success')
  const keep = flags.get('no-close-on-success')
  if (typeof close === 'string') {
    throw new RuntimeClientError('invalid_argument', '--close-on-success does not take a value')
  }
  if (typeof keep === 'string') {
    throw new RuntimeClientError('invalid_argument', '--no-close-on-success does not take a value')
  }
  if (close === true && keep === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --close-on-success or --no-close-on-success, not both.'
    )
  }
  return close === true ? true : keep === true ? false : undefined
}

export async function assertCloseOnSuccessSupported(
  client: RuntimeClient,
  closeOnSuccess: boolean | undefined
): Promise<void> {
  if (closeOnSuccess === undefined) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AUTOMATION_CLOSE_ON_SUCCESS_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on this host to use --close-on-success or --no-close-on-success.'
    )
  }
}

export function assertCloseOnSuccessSessionCompatible(
  reuseSession: boolean | undefined,
  closeOnSuccess: boolean | undefined
): void {
  if (reuseSession && closeOnSuccess) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--close-on-success cannot be combined with --reuse-session. Use --fresh-session to disable reuse.'
    )
  }
}

export async function resolveCloseOnSuccessEditOwner(
  client: RuntimeClient,
  id: string,
  updates: AutomationUpdateInput
): Promise<AutomationShowPayload['owner']> {
  const current = (await client.call<AutomationShowPayload>('automation.show', { id })).result
  assertCloseOnSuccessSessionCompatible(
    updates.reuseSession ?? current.automation.reuseSession,
    updates.closeOnSuccess ?? current.automation.closeOnSuccess
  )
  return current.owner
}
