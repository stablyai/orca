import { z } from 'zod'
import { canonicalAgentSessionDigest } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { CreateTerminalTab } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RpcContext } from '../../core'
import { rpcCallerOperationKey } from '../../callers/rpc-caller-identity'

const recordedStartupTab = z.looseObject({
  type: z.literal('terminal'),
  id: z.string().min(1),
  title: z.string(),
  parentTabId: z.string(),
  leafId: z.string(),
  isActive: z.boolean()
})
const recordedStartup = z.object({
  kind: z.literal('mobile-owned-startup'),
  result: z.looseObject({
    tab: z.discriminatedUnion('status', [
      recordedStartupTab.extend({ status: z.literal('ready'), terminal: z.string().min(1) }),
      recordedStartupTab.extend({ status: z.literal('pending-handle'), terminal: z.null() })
    ]),
    publicationEpoch: z.string(),
    snapshotVersion: z.number(),
    warning: z.literal('desktop-tab-not-shown').optional(),
    startupCwdFallback: z.literal('workspace-root').optional()
  })
})

function refuse(code: string, message = code): never {
  throw Object.assign(new Error(message), { code })
}

/** The existing durable ledger owns acceptance; a pruned or uncertain request never starts again. */
export async function runOwnedSessionStartup(
  params: z.infer<typeof CreateTerminalTab>,
  context: Pick<RpcContext, 'runtime' | 'caller'>,
  create: (onPtySpawnDispatched: () => void) => Promise<RuntimeMobileSessionCreateTerminalResult>
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  if (!context.caller || !params.clientMutationId) {
    return refuse('agent_session_identity_required')
  }
  const callerKey = rpcCallerOperationKey(context.caller)
  const operationId = params.clientMutationId
  const fingerprint = canonicalAgentSessionDigest({
    method: 'session.tabs.owned-startup',
    ...params
  })
  const store = await context.runtime.openAgentSessionRecordStore()
  const { decision, claim } = await store.admitAndClaimOperation({
    callerKey,
    operationId,
    fingerprint,
    now: Date.now()
  })
  if (decision.decision === 'refused') {
    return refuse(decision.code)
  }
  if (decision.decision === 'replay' && decision.row.outcome.status === 'succeeded') {
    const saved = recordedStartup.safeParse(decision.row.outcome.launch)
    if (saved.success) {
      return saved.data.result
    }
  }
  if (claim?.claim !== 'won') {
    return refuse(
      'agent_session_operation_unknown',
      'Startup delivery could not be confirmed. Check the workspace before trying again.'
    )
  }
  let dispatched = false
  try {
    const result = await create(() => {
      dispatched = true
    })
    const launch = recordedStartup.parse({ kind: 'mobile-owned-startup', result })
    await store.recordOperationOutcome({
      callerKey,
      operationId,
      outcome: {
        status: 'succeeded',
        sessionId: '',
        launch
      }
    })
    return result
  } catch (error) {
    // Only a failure before dispatch proves the command was not accepted.
    if (!dispatched) {
      await store.recordOperationOutcome({ callerKey, operationId, outcome: { status: 'pending' } })
    }
    throw error
  }
}
