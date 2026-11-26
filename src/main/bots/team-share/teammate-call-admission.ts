// A workspace teammate's call, once its method is admitted by teammate-method-classes.json. A trusted
// teammate has the owner's access: a call runs as the owner's would, whatever it names, and only what
// a `filtered` list answers is kept to the agent's workspaces (design §3.6: scoped is what the host
// lists, not what it refuses). The shared agent itself, its views and the caller's own connection
// keep the share guard every teammate has, so the tier only ever adds to what a teammate may do.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { teammateMethodClass } from '../../runtime/rpc/callers/teammate-method-classes'
import {
  admitBotShareCall,
  type BotShareRefusal
} from '../../runtime/rpc/dispatch/bot-share-call-admission'
import { withTeammateLists } from './teammate-workspace-lists'

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
  return kind === 'filtered' ? { ...admitted, method: withTeammateLists(method) } : admitted
}
