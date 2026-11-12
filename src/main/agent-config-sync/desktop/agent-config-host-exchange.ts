import {
  AGENT_CONFIG_KIND_GENERATIONS,
  AGENT_CONFIG_SYNC_PLAN_METHOD,
  AGENT_CONFIG_SYNC_PUT_METHOD,
  AgentConfigSyncPlanResult,
  AgentConfigSyncPutResult
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { agentConfigPutBatches, type DesiredAgentConfigItem } from './agent-config-sync-plan'

const PLAN_TIMEOUT_MS = 30_000
const PUT_TIMEOUT_MS = 60_000

export type AgentConfigHostCall = (
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<unknown>

export type AgentConfigExchange = {
  plan: AgentConfigSyncPlanResult
  put: AgentConfigSyncPutResult['items']
  sent: number
  /** Items an older sandbox can't take (its Orca predates their kind). */
  outdatedKeys: ReadonlySet<string>
}

function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
}

const refsOf = (items: readonly DesiredAgentConfigItem[]) =>
  items.map(({ scope, kind, name, digest }) => ({ scope, kind, name, digest }))

/** Plan, then put what the host lacks. An older sandbox gets the newest set of kinds it accepts;
 * the rest show as needing a newer workspace. */
export async function exchangeAgentConfig(
  call: AgentConfigHostCall,
  environmentId: string,
  syncer: string,
  desired: readonly DesiredAgentConfigItem[]
): Promise<AgentConfigExchange> {
  let sentItems: readonly DesiredAgentConfigItem[] = desired
  let plan: AgentConfigSyncPlanResult | null = null
  for (const [index, kinds] of AGENT_CONFIG_KIND_GENERATIONS.entries()) {
    const legacy = index === AGENT_CONFIG_KIND_GENERATIONS.length - 1
    sentItems = desired.filter((item) => kinds.includes(item.kind))
    try {
      plan = AgentConfigSyncPlanResult.parse(
        await call(
          environmentId,
          AGENT_CONFIG_SYNC_PLAN_METHOD,
          // The oldest sandboxes reject the `kinds` field itself.
          legacy
            ? { syncer, items: refsOf(sentItems) }
            : { syncer, items: refsOf(sentItems), kinds: [...kinds] },
          PLAN_TIMEOUT_MS
        )
      )
      break
    } catch (error) {
      if (legacy || errorCodeOf(error) !== 'invalid_argument') {
        throw error
      }
    }
  }
  if (!plan) {
    throw new Error('No sync protocol the sandbox accepts.')
  }
  const needed = sentItems.filter((item) => plan.items[item.key] === 'needed')
  const put: AgentConfigSyncPutResult['items'] = {}
  for (const batch of agentConfigPutBatches(needed)) {
    const answer = AgentConfigSyncPutResult.parse(
      await call(
        environmentId,
        AGENT_CONFIG_SYNC_PUT_METHOD,
        { syncer, items: batch },
        PUT_TIMEOUT_MS
      )
    )
    Object.assign(put, answer.items)
  }
  const sentKeys = new Set(sentItems.map((item) => item.key))
  return {
    plan,
    put,
    sent: needed.length,
    outdatedKeys: new Set(desired.filter((item) => !sentKeys.has(item.key)).map((item) => item.key))
  }
}
