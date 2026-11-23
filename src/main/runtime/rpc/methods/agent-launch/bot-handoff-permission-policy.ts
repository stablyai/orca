import { botCallerRequiresFullAccess } from '../../../../bots/bot-full-access-policy'
import { automationChatPermissionMode } from '../../../../../shared/automations/launch/automation-permission-policy'
import type { AgentLaunchParams } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import type { RpcContext } from '../../core'

export function botHandoffPermissionPolicy(
  params: AgentLaunchParams,
  context: RpcContext
): AgentLaunchParams {
  const caller = context.caller?.kind === 'local-cli' && context.orchestrationCompatibilityEvidence
  if (!caller || !botCallerRequiresFullAccess(context.runtime, caller)) {
    return params
  }
  automationChatPermissionMode(params.agent, { automationFullAccess: true }, true, undefined)
  if (params.reuseTerminal) {
    throw new Error('Full Access bot handoffs require a fresh agent.')
  }
  return {
    ...params,
    sessionOptions: { ...params.sessionOptions, permissionMode: 'full-access' },
    chatOptions: { ...params.chatOptions, permissionMode: 'full-access' }
  }
}
