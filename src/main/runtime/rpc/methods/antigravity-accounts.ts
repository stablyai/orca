import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
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
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentHostLaunchSources } from '../../structured-agent-launch-support'

/** Stops each running Antigravity chat on this host as a worktree teardown stops its chats; the
 *  chat stays, and its next send starts the agent again. */
async function stopLiveAntigravityChats(): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const ids = host.loadedSessionIds().filter((id) => host.sessionAgent(id) === 'antigravity')
  // Every close settles before the caller's fence releases, even when one rejects.
  const closes = await Promise.allSettled(ids.map((id) => host.close(id, 'evict')))
  // A close that could not prove its child gone keeps it loaded.
  const stillLoaded = host.loadedSessionIds().some((id) => ids.includes(id))
  if (stillLoaded || closes.some((close) => close.status === 'rejected')) {
    throw new Error('An Antigravity chat on this host could not be stopped. Try again.')
  }
}

const chatSignInHost = (runtime: OrcaRuntimeService) => ({
  launchSources: () => structuredAgentHostLaunchSources('antigravity', runtime),
  stopLiveChats: stopLiveAntigravityChats
})

/** The caller a sign-in belongs to, as its transport proved it; one it can't name gets none. */
function signInOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign Antigravity in.')
  }
  return rpcCallerOperationKey(caller)
}

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
    handler: async (_, ctx) =>
      startAntigravityChatSignIn(chatSignInHost(ctx.runtime), signInOwner(ctx))
  }),
  // A full snapshot on subscribe, then one per revision, until the transport closes.
  defineStreamingMethod({
    name: 'accounts.antigravityChatSignInSubscribe',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, ctx, emit) => {
      // A caller with no identity owns no flow, so it sees every flow as another client's.
      const owner = ctx.caller ? rpcCallerOperationKey(ctx.caller) : ''
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `antigravityChatSignIn:${ctx.connectionId ?? 'local'}${frame}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = subscribeAntigravityChatSignIn(() => emit(readAntigravityChatSignInStatus(owner)))
      emit(readAntigravityChatSignInStatus(owner))
    }
  }),
  defineMethod({
    name: 'accounts.antigravityChatSignInCancel',
    permission: 'accounts-admin',
    params: AntigravityChatSignInFlowParams,
    handler: async ({ flowId }, ctx) => cancelAntigravityChatSignIn(signInOwner(ctx), flowId)
  }),
  // The address a browser on another computer ended on, sent to the listener on this host.
  defineMethod({
    name: 'accounts.antigravityChatSignInComplete',
    permission: 'accounts-admin',
    params: AntigravityChatSignInCompleteParams,
    handler: async ({ flowId, callbackUrl }, ctx) =>
      completeAntigravityChatSignIn(signInOwner(ctx), flowId, callbackUrl)
  })
] as const
