// A client from before a host-checked source counts every such rule as a missing connector and throws
// naming it, so it gets each automation without them. Local callers and newer clients see all.
import { isGoogleTrigger } from '../../../shared/automation-google-triggers'
import {
  isNgitTrigger,
  NGIT_TRIGGERS_RUNTIME_CAPABILITY
} from '../../../shared/automation-ngit-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { GOOGLE_TRIGGERS_RUNTIME_CAPABILITY } from '../../../shared/google/google-connect-types'
import type { RpcContext } from './core'

type ClientContext = Pick<RpcContext, 'clientCapabilities'>

function reads(context: ClientContext, capability: string): boolean {
  return (
    context.clientCapabilities === undefined ||
    context.clientCapabilities.some((declared) => declared === capability)
  )
}

export function readsGoogleRules(context: ClientContext): boolean {
  return reads(context, GOOGLE_TRIGGERS_RUNTIME_CAPABILITY)
}

export function readsEveryHostRule(context: ClientContext): boolean {
  return readsGoogleRules(context) && reads(context, NGIT_TRIGGERS_RUNTIME_CAPABILITY)
}

export function automationForClient<A extends Pick<Automation, 'on'>>(
  automation: A,
  context: ClientContext
): A {
  const google = readsGoogleRules(context)
  const ngit = reads(context, NGIT_TRIGGERS_RUNTIME_CAPABILITY)
  const hidden = (rule: NonNullable<A['on']>[number]): boolean =>
    (!google && isGoogleTrigger(rule)) || (!ngit && isNgitTrigger(rule))
  if (!automation.on?.some(hidden)) {
    return automation
  }
  return { ...automation, on: automation.on.filter((rule) => !hidden(rule)) }
}
