import * as z from 'zod'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { salvagedOptional } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../transport/rpc/rpc-operation-contract'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { settingsMember } from '../../settings/mobile-settings-projection'

// New-tab checks the sibling's refusal before touching settings, but after its own refusal.
const newTabSettingsReader: RpcCompatibleReader<
  unknown,
  'deferred-settings-member',
  () => unknown
> = (raw) => ({
  compatible: true,
  variant: 'deferred-settings-member',
  value: () => settingsMember(raw),
  salvage: { droppedPaths: [], droppedCount: 0 }
})

export const newTabSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.new-tab-message-error',
    method: 'settings.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: newTabSettingsReader
  })
)

export const agentLaunchPolicyRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.mobile-automation-agent-policy',
    method: 'settings.getAgentLaunch',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'agent-policy',
      z.object({
        settings: z.object({
          // A newer host's default agent reads as unset, so agent discovery still loads.
          defaultTuiAgent: salvagedOptional(
            'defaultTuiAgent',
            z
              .custom<TuiAgent | 'blank'>((value) => isTuiAgent(value) || value === 'blank')
              .nullable()
          ),
          disabledTuiAgents: z.array(z.string()).optional()
        })
      })
    )
  })
)

type AgentLaunchPolicy = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: string[]
}

/**
 * The paired desktop answers settings.get even in a server workspace it relays, so read the
 * server's own default and hidden agents there, as desktop does. Deferred like the settings read.
 */
export async function requestServerAgentPolicy(
  client: RpcClient
): Promise<() => AgentLaunchPolicy | null> {
  if (!client.requestRoute?.(undefined).intermediary) {
    return () => null
  }
  const reply = await agentLaunchPolicyRead.request(client)
  // A server older than the method keeps the desktop's agent order.
  if (!reply.ok && isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
    return () => null
  }
  return () => agentLaunchPolicyRead.interpret(reply).settings
}

export function withServerAgentPolicy(
  settings: unknown,
  policy: AgentLaunchPolicy | null
): unknown {
  if (!policy || typeof settings !== 'object' || settings === null) {
    return settings
  }
  return {
    ...settings,
    defaultTuiAgent: policy.defaultTuiAgent ?? null,
    disabledTuiAgents: policy.disabledTuiAgents ?? []
  }
}
