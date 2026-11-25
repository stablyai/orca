import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import {
  getOrcaServerSignIn,
  type OrcaServerSignIn
} from '../../../orca-profiles/orca-server-sign-in'
import {
  OrcaAccountSelectOrgParams,
  OrcaAccountSignInCompleteParams,
  OrcaAccountSignInFlowParams,
  OrcaAccountSignInStartParams,
  OrcaAccountSignInWaitParams,
  OrcaAccountUnsubscribeParams
} from '../../../../shared/rpc-contract/orca-account-params'

// Per-process counter: same-millisecond subscriptions must not evict each other's cleanup.
let subscriptionSeq = 0

function server(): OrcaServerSignIn {
  const installed = getOrcaServerSignIn()
  if (!installed) {
    throw new Error('Signing in to Orca is not available on this host. Update Orca on it.')
  }
  return installed
}

function flowOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign this host in.')
  }
  return rpcCallerOperationKey(caller)
}

// `workspace`: anyone who can run commands here could run the sign-in in a terminal anyway.
export const ORCA_ACCOUNT_METHODS = [
  defineMethod({
    name: 'orcaAccount.status',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async () => server().status()
  }),
  defineMethod({
    name: 'orcaAccount.signIn.start',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountSignInStartParams,
    handler: async ({ switchAccount, approveInBrowser }, ctx) =>
      server().startSignIn(flowOwner(ctx), switchAccount ? 'switch-account' : 'sign-in', {
        approveInBrowser
      })
  }),
  defineMethod({
    name: 'orcaAccount.signIn.wait',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountSignInWaitParams,
    handler: async ({ flowId, afterRevision }, ctx) =>
      server().waitSignIn(flowOwner(ctx), flowId, afterRevision, ctx.signal)
  }),
  defineMethod({
    name: 'orcaAccount.signIn.complete',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountSignInCompleteParams,
    handler: async ({ flowId, code, state, redirectUri }, ctx) =>
      server().completeSignIn(flowOwner(ctx), flowId, { code, state, redirectUri })
  }),
  defineMethod({
    name: 'orcaAccount.signIn.cancel',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountSignInFlowParams,
    handler: async ({ flowId }, ctx) => server().cancelSignIn(flowOwner(ctx), flowId)
  }),
  defineMethod({
    name: 'orcaAccount.selectOrg',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountSelectOrgParams,
    handler: async ({ orgId }) => server().selectOrg(orgId)
  }),
  defineMethod({
    name: 'orcaAccount.signOut',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async () => server().signOut()
  }),
  defineStreamingMethod({
    name: 'orcaAccount.subscribe',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      const account = server()
      await new Promise<void>((resolve) => {
        const unsubscribe = account.onChanged((status) => emit({ type: 'status', status }))
        const subscriptionId = `orca-account-${connectionId ?? 'inproc'}-${++subscriptionSeq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId, status: account.status() })
      })
    }
  }),
  defineMethod({
    name: 'orcaAccount.unsubscribe',
    permission: 'workspace',
    share: 'not-shared',
    params: OrcaAccountUnsubscribeParams,
    handler: async ({ subscriptionId }, { runtime }) => {
      runtime.cleanupSubscription(subscriptionId)
      return { unsubscribed: true }
    }
  })
]
