import { defineMethod, type RpcContext } from '../../core'
import { rpcCallerOperationKey } from '../../callers/rpc-caller-identity'
import { HostAccountSignInFlows } from '../../../agent-session/environment/host-account-sign-in-flows'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { agentSignInMethods } from './agent-sign-in-methods'
import {
  HostAccountSignInStartParams,
  HostAccountSignInWaitParams,
  HostAccountSignInFlowParams,
  HostAccountSignInCodeParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'

const hostSignIns = new WeakMap<OrcaRuntimeService, HostAccountSignInFlows>()
function hostSignInFlows(runtime: OrcaRuntimeService): HostAccountSignInFlows {
  let flows = hostSignIns.get(runtime)
  if (!flows) {
    flows = new HostAccountSignInFlows((provider, channel) =>
      runtime.runHostAccountSignIn(provider, channel)
    )
    hostSignIns.set(runtime, flows)
  }
  return flows
}

/** The caller a sign-in belongs to, as its transport proved it; one it can't name gets none. */
function signInOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot add accounts on this host.')
  }
  return rpcCallerOperationKey(caller)
}

export const HOST_SIGN_IN_METHODS = [
  // Credentials stay on this host; the caller opens the page and relays its code (#20009).
  defineMethod({
    name: 'accounts.hostSignInStart',
    permission: 'accounts-admin',
    params: HostAccountSignInStartParams,
    handler: async ({ provider, callback }, ctx) =>
      hostSignInFlows(ctx.runtime).start(signInOwner(ctx), provider, { callback })
  }),
  ...agentSignInMethods(hostSignInFlows, signInOwner),
  defineMethod({
    name: 'accounts.hostSignInWait',
    permission: 'accounts-admin',
    params: HostAccountSignInWaitParams,
    handler: async ({ flowId, afterRevision }, ctx) =>
      hostSignInFlows(ctx.runtime).wait(signInOwner(ctx), flowId, afterRevision, ctx.signal)
  }),
  defineMethod({
    name: 'accounts.hostSignInSubmitCode',
    permission: 'accounts-admin',
    params: HostAccountSignInCodeParams,
    handler: async ({ flowId, code }, ctx) =>
      hostSignInFlows(ctx.runtime).submitCode(signInOwner(ctx), flowId, code)
  }),
  defineMethod({
    name: 'accounts.hostSignInCancel',
    permission: 'accounts-admin',
    params: HostAccountSignInFlowParams,
    handler: async ({ flowId }, ctx) =>
      hostSignInFlows(ctx.runtime).cancel(signInOwner(ctx), flowId)
  })
]
