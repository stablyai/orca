import { defineMethod, defineStreamingMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams,
  AntigravityChatSignInCompleteParams,
  AntigravityChatSignInFlowParams
} from '../../../../shared/rpc-contract/antigravity-accounts-params'
import { getAntigravityAccountService } from '../../../antigravity/native-account-host'
import {
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  readAntigravityChatSignInStatus,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from '../../../antigravity/antigravity-chat-sign-in'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { stopStructuredAgentChats } from '../../structured-agent-chat-stop'

const chatSignInHost = (runtime: OrcaRuntimeService) => ({
  launchSources: () => runtime.resolveStructuredAgentHostLaunchSources('antigravity'),
  stopLiveChats: () => stopStructuredAgentChats('antigravity', 'Antigravity')
})

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    permission: 'workspace',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).listAccounts()
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).addCurrentAccount()
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).selectAccount(accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).removeAccount(accountId)
  }),
  // The sign-in runs on this execution host, whichever client asks, as its chats do.
  defineMethod({
    name: 'accounts.antigravityChatSignInStart',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime }) => startAntigravityChatSignIn(chatSignInHost(runtime))
  }),
  // A full snapshot on subscribe, then one per revision, until the transport closes.
  defineStreamingMethod({
    name: 'accounts.antigravityChatSignInSubscribe',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx, emit) => {
      const accountHome = await ctx.runtime.resolveStructuredAgentAccountHome('antigravity')
      // A failed first read fails the subscribe; a later one keeps the client's last snapshot.
      let shown = await readAntigravityChatSignInStatus(accountHome)
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `antigravityChatSignIn:${ctx.connectionId ?? 'local'}${frame}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      // Revisions only grow, so a read that ends after a newer one is dropped.
      const follow = (): void =>
        void readAntigravityChatSignInStatus(accountHome).then(
          (next) => {
            if (next.revision > shown.revision && !stream.isClosed()) {
              shown = next
              emit(next)
            }
          },
          (error) => console.warn('[antigravity] sign-in status not read for a subscriber:', error)
        )
      dispose = subscribeAntigravityChatSignIn(follow)
      emit(shown)
      // Catches a revision between the first read and the subscribe.
      follow()
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInCancel',
    permission: 'accounts-admin',
    params: AntigravityChatSignInFlowParams,
    handler: async ({ flowId }) => cancelAntigravityChatSignIn(flowId)
  }),
  // The address a browser on another computer ended on, sent to the listener on this host.
  defineMethod({
    name: 'accounts.antigravityChatSignInComplete',
    permission: 'accounts-admin',
    params: AntigravityChatSignInCompleteParams,
    handler: async ({ flowId, callbackUrl }) => completeAntigravityChatSignIn(flowId, callbackUrl)
  })
] as const
