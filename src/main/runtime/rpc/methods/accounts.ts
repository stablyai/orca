import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import type { OrcadFeature } from '../orcad-feature-readiness'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { HostAccountSignInFlows } from '../../host-account-sign-in-flows'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  AddDataAccountParams,
  SelectDataAccountParams,
  RemoveDataAccountParams,
  AccountsUnsubscribeParams,
  BeginClaudeSignInParams,
  FinishClaudeSignInParams,
  AddClaudeFromConfigDirParams,
  AddCodexFromHomeParams,
  ConsumeCodexResetCreditParams,
  ListAccountsParams,
  RemoveAccountParams,
  SelectAccountParams,
  SelectCodexAccountForTargetParams,
  HostAccountSignInStartParams,
  HostAccountSignInWaitParams,
  HostAccountSignInFlowParams,
  HostAccountSignInCodeParams
} from '../../../../shared/rpc-contract/accounts-params'
import { HostAccountLaunchEnvParams } from '../../../../shared/host-account-launch-env'

// Use a per-process counter: same-millisecond subscriptions must not evict each other's cleanup.
let accountsSubscriptionSeq = 0

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

const ACCOUNT_METHOD_DEFINITIONS = [
  // Only the owning desktop pushes this host's account launch environment, including WSL.
  defineMethod({
    name: 'accounts.setHostLaunchEnv',
    permission: 'accounts-admin',
    params: HostAccountLaunchEnvParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind === 'mobile') {
        throw new Error('Only the Orca desktop that owns this host can set its accounts.')
      }
      runtime.setHostAccountLaunchEnv(params)
      return {}
    }
  }),
  // Local only: sign-in opens claude auth login on the execution host.
  defineMethod({
    name: 'accounts.beginClaudeSignIn',
    permission: 'accounts-admin',
    params: BeginClaudeSignInParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Sign in on the Orca execution host.')
      }
      return runtime.beginClaudeSignIn(params)
    }
  }),
  defineMethod({
    name: 'accounts.finishClaudeSignIn',
    permission: 'accounts-admin',
    params: FinishClaudeSignInParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Sign in on the Orca execution host.')
      }
      return runtime.finishClaudeSignIn(params)
    }
  }),
  defineMethod({
    name: 'accounts.cancelClaudeSignIn',
    permission: 'accounts-admin',
    params: FinishClaudeSignInParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Sign in on the Orca execution host.')
      }
      await runtime.cancelClaudeSignIn(params)
      return {}
    }
  }),
  defineMethod({
    name: 'accounts.listData',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getDataAccountsSnapshot()
  }),
  defineMethod({
    name: 'accounts.addDataFromHome',
    permission: 'accounts-admin',
    params: AddDataAccountParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Adding accounts is only available on the Orca host runtime.')
      }
      return runtime.addDataAccountFromHome(params.provider, params.sourceDataHome, params.label)
    }
  }),
  defineMethod({
    name: 'accounts.selectData',
    permission: 'accounts-admin',
    params: SelectDataAccountParams,
    handler: async (params, { runtime }) =>
      runtime.selectDataAccount(params.provider, params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeData',
    permission: 'accounts-admin',
    params: RemoveDataAccountParams,
    handler: async (params, { runtime }) =>
      runtime.removeDataAccount(params.provider, params.accountId)
  }),
  defineMethod({
    name: 'accounts.list',
    permission: 'workspace',
    params: ListAccountsParams,
    handler: async (params, { runtime }) => {
      // Refresh before replying: unfocused desktop polling and unopened account caches can leave mobile usage stale.
      if (params.refreshUsage) {
        await runtime.refreshAccountsForMobile()
      }
      return runtime.getAccountsSnapshot()
    }
  }),
  defineMethod({
    name: 'accounts.selectClaude',
    permission: 'accounts-admin',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.selectCodex',
    permission: 'accounts-admin',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectCodexAccount(params.accountId)
  }),
  defineMethod({
    // Use a distinct RPC: old hosts strip unknown target fields and could otherwise clear the host slot.
    name: 'accounts.selectCodexForTarget',
    permission: 'accounts-admin',
    params: SelectCodexAccountForTargetParams,
    handler: async (params, { runtime }) =>
      runtime.selectCodexAccountForTarget(params.accountId, params.target)
  }),
  defineMethod({
    name: 'accounts.consumeCodexResetCredit',
    permission: 'accounts-admin',
    params: ConsumeCodexResetCreditParams,
    handler: async (params, { runtime }) =>
      runtime.consumeCodexRateLimitResetCredit(params.idempotencyKey, params.expectedScope)
  }),
  defineMethod({
    name: 'accounts.removeClaude',
    permission: 'accounts-admin',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeCodex',
    permission: 'accounts-admin',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeCodexAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.addClaudeFromConfigDir',
    permission: 'accounts-admin',
    params: AddClaudeFromConfigDirParams,
    handler: async () => {
      throw new Error(
        'Update the Orca CLI to add accounts. Importing Claude logins is no longer supported.'
      )
    }
  }),
  defineMethod({
    name: 'accounts.addCodexFromHome',
    permission: 'accounts-admin',
    params: AddCodexFromHomeParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Adding Codex accounts is only available on the Orca host runtime.')
      }
      return runtime.addCodexAccountFromHome(params.sourceHome, {
        runtime: params.runtime,
        wslDistro: params.wslDistro ?? null
      })
    }
  }),
  // Credentials stay on this host; the caller opens the page and relays its code (#20009).
  defineMethod({
    name: 'accounts.hostSignInStart',
    permission: 'accounts-admin',
    params: HostAccountSignInStartParams,
    handler: async ({ provider }, ctx) =>
      hostSignInFlows(ctx.runtime).start(signInOwner(ctx), provider)
  }),
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
  }),
  // Stream rate-limit polls and account switches to mobile without reopening the screen.
  defineStreamingMethod({
    name: 'accounts.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, connectionId, signal }, emit) => {
      if (signal?.aborted) {
        return
      }
      const stopped = Promise.withResolvers<void>()
      const unsubscribe = runtime.onAccountsChanged((snapshot) => {
        emit({ type: 'snapshot', snapshot })
      })

      // Key cleanup by socket plus sequence so sibling sockets and concurrent subscribes cannot evict each other.
      const seq = ++accountsSubscriptionSeq
      const subscriptionId = `accounts-${connectionId ?? 'inproc'}-${seq}`
      const release = (): void => runtime.cleanupSubscription(subscriptionId)
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          signal?.removeEventListener('abort', release)
          unsubscribe()
          stopped.resolve()
        },
        connectionId
      )

      try {
        if (signal?.aborted) {
          release()
        } else {
          signal?.addEventListener('abort', release, { once: true })
          // Publish a snapshot immediately, then refresh stale data; reconnect must not force repeated provider fetches.
          emit({ type: 'ready', subscriptionId, snapshot: runtime.getAccountsStreamSnapshot() })
          void runtime.refreshAccountsForMobileSubscriber()
        }
        await stopped.promise
        emit({ type: 'end' })
      } finally {
        release()
      }
    }
  }),
  defineMethod({
    name: 'accounts.unsubscribe',
    permission: 'workspace',
    params: AccountsUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]

// The desktop's launch-env push and unsubscribes never touch the account services.
const ACCOUNT_SERVICE_FREE_METHODS: ReadonlySet<string> = new Set([
  'accounts.setHostLaunchEnv',
  'accounts.unsubscribe'
])

export const ACCOUNT_METHODS = ACCOUNT_METHOD_DEFINITIONS.map((method) =>
  ACCOUNT_SERVICE_FREE_METHODS.has(method.name)
    ? method
    : { ...method, requires: ['accounts'] satisfies OrcadFeature[] }
)
