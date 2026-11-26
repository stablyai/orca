// A workspace teammate's call, once its method is admitted by teammate-method-classes.json: a `scoped`
// call must name the agent's targets (teammate-call-targets.ts) and nothing else; a `filtered` call
// may name only the agent's and runs with its answer kept to them; an `own` call runs as it is. The
// shared agent itself, its views and the caller's own connection keep the share guard every teammate
// has, so the tier only ever adds to what a teammate may do.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { teammateMethodClass } from '../../runtime/rpc/callers/teammate-method-classes'
import {
  admitBotShareCall,
  type BotShareRefusal
} from '../../runtime/rpc/dispatch/bot-share-call-admission'
import { readTeammateWorkspaceSet } from './agent-workspace-tracker'
import { withTeammateLists } from './teammate-workspace-lists'
import {
  TEAMMATE_HOST_FACT_METHODS,
  teammateCallTargets,
  teammateTargetIsAgents
} from './teammate-call-targets'

type Admitted = { method: RpcMethod | RpcStreamingMethod; params: unknown }

export async function admitTeammateCall<A extends Admitted>(
  context: RpcContext,
  scope: BotShareCallerScope,
  admitted: A
): Promise<A | { refusal: BotShareRefusal }> {
  const { method, params } = admitted
  // The shared agent itself, its views, and the caller's own connection: as for any teammate.
  if (method.share !== 'not-shared' && ['bot', 'scoped', 'self'].includes(method.share.kind)) {
    const answer = await admitBotShareCall(context.runtime, scope, method.share, params)
    return 'refusal' in answer ? answer : { ...admitted, params: answer.params }
  }
  const kind = teammateMethodClass(method.name)
  if (kind === 'refused') {
    return { refusal: 'method_not_found' }
  }
  if (kind === 'own') {
    return admitted
  }
  const targets = teammateCallTargets(method.name, method.share, params)
  // A scoped call that names nothing would act on the owner's whole host (their active tab or
  // terminal, every port); only host facts may.
  if (kind === 'scoped' && targets.length === 0 && !TEAMMATE_HOST_FACT_METHODS.has(method.name)) {
    return { refusal: 'path_not_found' }
  }
  const set = await readTeammateWorkspaceSet(context.runtime, scope)
  if (targets.some((target) => target.kind === 'chat' || target.kind === 'new-chat')) {
    // The chat records live in the chat host, which opens lazily.
    await context.runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  for (const target of targets) {
    if (!(await teammateTargetIsAgents(context, set, target))) {
      return { refusal: 'path_not_found' }
    }
  }
  return kind === 'filtered' ? { ...admitted, method: withTeammateLists(method) } : admitted
}
