// A client from before Google rules counts every Gmail or Calendar rule as a missing connector and
// throws naming it, so it gets each automation without them. Local callers and newer clients see all.
import { isGoogleTrigger } from '../../../shared/automation-google-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { GOOGLE_TRIGGERS_RUNTIME_CAPABILITY } from '../../../shared/google/google-connect-types'
import type { RpcContext } from './core'

export function readsGoogleRules(context: Pick<RpcContext, 'clientCapabilities'>): boolean {
  return (
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(GOOGLE_TRIGGERS_RUNTIME_CAPABILITY)
  )
}

function withoutGoogle<A extends Pick<Automation, 'on'>>(automation: A): A {
  if (!automation.on?.some((rule) => isGoogleTrigger(rule))) {
    return automation
  }
  return { ...automation, on: automation.on.filter((rule) => !isGoogleTrigger(rule)) }
}

export function automationForClient<A extends Pick<Automation, 'on'>>(
  automation: A,
  context: Pick<RpcContext, 'clientCapabilities'>
): A {
  return readsGoogleRules(context) ? automation : withoutGoogle(automation)
}
