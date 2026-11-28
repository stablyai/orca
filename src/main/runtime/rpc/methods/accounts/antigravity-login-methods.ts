import { defineMethod, defineStreamingMethod } from '../../core'
import { AntigravityLoginUnsubscribeParams } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import {
  agyLoginRevision,
  followAgyLoginChanges
} from '../../../../antigravity/agy-login-change-watch'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'

/** Settings' host account rows follow agy's stored login through these, so they show a login
 *  agy wrote elsewhere (a terminal sign-in, a token refresh) without a Refresh. */
export const ANTIGRAVITY_LOGIN_METHODS = [
  defineStreamingMethod({
    // Only Settings' host account rows follow it, so chats never watch agy's login stores.
    name: 'accounts.antigravityLoginSubscribe',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx, emit) => {
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `antigravityLogin:${ctx.connectionId ?? 'local'}${frame}`
      let dispose = (): void => {}
      // A remote client shares its control connection, so it ends the stream by its request id.
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose(), true)
      if (stream.isClosed()) {
        return
      }
      dispose = followAgyLoginChanges((loginRevision) => emit({ loginRevision }))
      // The first frame is the count so far, so the next one is a change.
      emit({ loginRevision: agyLoginRevision() })
    }
  }),
  defineMethod({
    name: 'accounts.antigravityLoginUnsubscribe',
    permission: 'accounts-admin',
    params: AntigravityLoginUnsubscribeParams,
    handler: async ({ subscriptionId }, ctx) => {
      ctx.runtime.releaseSubscriptionByRequest(ctx.connectionId, subscriptionId)
      return { unsubscribed: true }
    }
  })
] as const
