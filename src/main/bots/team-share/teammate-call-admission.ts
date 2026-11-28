// A workspace teammate's call, once its method is admitted by teammate-method-classes.json. A trusted
// teammate has the owner's access: a call runs as the owner's would, whatever it names, and only what
// a `filtered` list answers is kept to the agent's workspaces (design §3.6: scoped is what the host
// lists, not what it refuses). The shared agent itself, its views and the caller's own connection
// keep the share guard every teammate has, so the tier only ever adds to what a teammate may do.
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../../runtime/rpc/core'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { teammateMethodClass, writesHostTabList } from './teammate-rules'
import {
  admitBotShareCall,
  type BotShareRefusal
} from '../../runtime/rpc/dispatch/bot-share-call-admission'
import { withTeammateLists } from './teammate-workspace-lists'

import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

type Admitted = { method: RpcMethod | RpcStreamingMethod; params: unknown }

const NamedWorkspace = lazyZodSchema(() =>
  z.looseObject({
    worktree: z.string().optional().catch(undefined),
    target: z
      .looseObject({ worktree: z.string().optional().catch(undefined) })
      .optional()
      .catch(undefined)
  })
)

/** The workspace a call names: `worktree`, or a launch `target`'s. A target that makes a new
 *  workspace names it too (`new`); `none` leaves the host's window to pick one. */
function namedWorktree(params: unknown): { worktree: string } | 'new' | 'none' {
  const named = NamedWorkspace.safeParse(params).data
  const worktree = named?.worktree ?? named?.target?.worktree
  return worktree !== undefined ? { worktree } : named?.target ? 'new' : 'none'
}

/** Rule 4: in their own Home a teammate's list is their own (their terminals, pages and files open
 *  there through it), so nothing they call opens, moves or reshapes a tab of the host's list there;
 *  and a teammate never opens one in whatever workspace the host's window shows, so a call naming none
 *  is refused. */
async function writesHostTabsInOwnHome(
  context: RpcContext,
  scope: BotShareCallerScope,
  methodName: string,
  params: unknown
): Promise<boolean> {
  if (!writesHostTabList(methodName)) {
    return false
  }
  const named = namedWorktree(params)
  return (
    named === 'none' ||
    (named !== 'new' && (await context.runtime.namesTeammateHome(named.worktree, scope)))
  )
}

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
  if (kind === 'refused' || (await writesHostTabsInOwnHome(context, scope, method.name, params))) {
    return { refusal: 'method_not_found' }
  }
  return kind === 'filtered' ? { ...admitted, method: withTeammateLists(method) } : admitted
}
