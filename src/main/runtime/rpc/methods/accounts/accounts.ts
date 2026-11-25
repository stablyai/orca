import { defineMethod, type RpcContext } from '../../core'
import { ACCOUNT_SUBSCRIPTION_METHOD } from './account-subscription-method'
import { ACCOUNT_RENAME_METHODS } from './account-rename-methods'
import type { OrcadFeature } from '../../startup/orcad-readiness'
import { rpcCallerOperationKey } from '../../callers/rpc-caller-identity'
import { HostAccountSignInFlows } from '../../../agent-session/environment/host-account-sign-in-flows'
import type { OrcaRuntimeService } from '../../../orca-runtime'
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
  SelectClaudeAccountParams,
  SelectCodexAccountForTargetParams,
  HostAccountSignInStartParams,
  HostAccountSignInWaitParams,
  HostAccountSignInFlowParams,
  HostAccountSignInCodeParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'
import { HostAccountLaunchEnvParams } from '../../../../../shared/agent-launch/startup/host-account-launch-env'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'

// Why 10s: well under the CLI's 60s request timeout even when several Codex homes probe slowly.
const STALE_USAGE_WAIT_MS = 10_000

const hostSignIns = new WeakMap<OrcaRuntimeService, HostAccountSignInFlows>()
function hostSignInFlows(runtime: OrcaRuntimeService): HostAccountSignInFlows {
  let flows = hostSignIns.get(runtime)
  if (!flows) {
    flows = new HostAccountSignInFlows((provider, channel, accountId) =>
      runtime.runHostAccountSignIn(provider, channel, accountId)
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
    share: 'not-shared',
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
    share: 'not-shared',
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
    share: 'not-shared',
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
    share: 'not-shared',
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
    share: 'not-shared',
    params: null,
    handler: async (_, { runtime }) => runtime.getDataAccountsSnapshot()
  }),
  defineMethod({
    name: 'accounts.addDataFromHome',
    permission: 'accounts-admin',
    share: 'not-shared',
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
    share: 'not-shared',
    params: SelectDataAccountParams,
    handler: async (params, { runtime }) =>
      runtime.selectDataAccount(params.provider, params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeData',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: RemoveDataAccountParams,
    handler: async (params, { runtime }) =>
      runtime.removeDataAccount(params.provider, params.accountId)
  }),
  defineMethod({
    name: 'accounts.list',
    permission: 'workspace',
    share: 'not-shared',
    params: ListAccountsParams,
    handler: async (params, { runtime }) => {
      // Refresh before replying: unfocused desktop polling and unopened account caches can leave mobile usage stale.
      if (params.refreshUsage) {
        await runtime.refreshAccountsForMobile()
      } else if (params.refreshStaleUsage) {
        // Slow inactive-account probes keep running; the caller gets what settled in time.
        await withTimeout(
          runtime.refreshAccountsForMobileSubscriber(),
          STALE_USAGE_WAIT_MS,
          undefined
        )
      }
      return runtime.getAccountsSnapshot()
    }
  }),
  defineMethod({
    name: 'accounts.selectClaude',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: SelectClaudeAccountParams,
    handler: async ({ accountId, ...options }, { runtime }) =>
      runtime.selectClaudeAccount(accountId, options)
  }),
  defineMethod({
    name: 'accounts.selectCodex',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectCodexAccount(params.accountId)
  }),
  defineMethod({
    // Use a distinct RPC: old hosts strip unknown target fields and could otherwise clear the host slot.
    name: 'accounts.selectCodexForTarget',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: SelectCodexAccountForTargetParams,
    handler: async (params, { runtime }) =>
      runtime.selectCodexAccountForTarget(params.accountId, params.target)
  }),
  defineMethod({
    name: 'accounts.consumeCodexResetCredit',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: ConsumeCodexResetCreditParams,
    handler: async (params, { runtime }) =>
      runtime.consumeCodexRateLimitResetCredit(params.idempotencyKey, params.expectedScope)
  }),
  defineMethod({
    name: 'accounts.removeClaude',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeCodex',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeCodexAccount(params.accountId)
  }),
  ...ACCOUNT_RENAME_METHODS,
  defineMethod({
    name: 'accounts.addClaudeFromConfigDir',
    permission: 'accounts-admin',
    share: 'not-shared',
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
    share: 'not-shared',
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
    share: 'not-shared',
    params: HostAccountSignInStartParams,
    handler: async ({ provider, accountId }, ctx) =>
      hostSignInFlows(ctx.runtime).start(signInOwner(ctx), provider, accountId)
  }),
  defineMethod({
    name: 'accounts.hostSignInWait',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: HostAccountSignInWaitParams,
    handler: async ({ flowId, afterRevision }, ctx) =>
      hostSignInFlows(ctx.runtime).wait(signInOwner(ctx), flowId, afterRevision, ctx.signal)
  }),
  defineMethod({
    name: 'accounts.hostSignInSubmitCode',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: HostAccountSignInCodeParams,
    handler: async ({ flowId, code }, ctx) =>
      hostSignInFlows(ctx.runtime).submitCode(signInOwner(ctx), flowId, code)
  }),
  defineMethod({
    name: 'accounts.hostSignInCancel',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: HostAccountSignInFlowParams,
    handler: async ({ flowId }, ctx) =>
      hostSignInFlows(ctx.runtime).cancel(signInOwner(ctx), flowId)
  }),
  ACCOUNT_SUBSCRIPTION_METHOD,
  defineMethod({
    name: 'accounts.unsubscribe',
    permission: 'workspace',
    share: 'not-shared',
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
