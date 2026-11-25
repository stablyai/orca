// A client from before Google or Teams rules counts each such rule as a missing connector and throws
// naming it, so it gets each automation without the rules it can't read. Local callers and newer
// clients see all.
import { isGoogleTrigger } from '../../../shared/automation-google-triggers'
import { isTeamsTrigger } from '../../../shared/automation-teams-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { GOOGLE_TRIGGERS_RUNTIME_CAPABILITY } from '../../../shared/google/google-connect-types'
import { TEAMS_TRIGGERS_RUNTIME_CAPABILITY } from '../../../shared/teams/teams-connect-types'
import type { RpcContext } from './core'

const reads = (context: Pick<RpcContext, 'clientCapabilities'>, capability: string): boolean =>
  context.clientCapabilities === undefined || context.clientCapabilities.includes(capability)

/** Whether this client reads every rule the host checks itself, so automations go to it unchanged. */
export function readsHostCheckedRules(context: Pick<RpcContext, 'clientCapabilities'>): boolean {
  return (
    reads(context, GOOGLE_TRIGGERS_RUNTIME_CAPABILITY) &&
    reads(context, TEAMS_TRIGGERS_RUNTIME_CAPABILITY)
  )
}

export function automationForClient<A extends Pick<Automation, 'on'>>(
  automation: A,
  context: Pick<RpcContext, 'clientCapabilities'>
): A {
  const google = reads(context, GOOGLE_TRIGGERS_RUNTIME_CAPABILITY)
  const teams = reads(context, TEAMS_TRIGGERS_RUNTIME_CAPABILITY)
  const unread = (rule: NonNullable<A['on']>[number]): boolean =>
    (!google && isGoogleTrigger(rule)) || (!teams && isTeamsTrigger(rule))
  if (!automation.on?.some(unread)) {
    return automation
  }
  return { ...automation, on: automation.on.filter((rule) => !unread(rule)) }
}
