import { defineMethod, type RpcContext } from '../../core'
import type { HostAccountSignInFlows } from '../../../agent-session/environment/host-account-sign-in-flows'
import { createAuthCallbackTunnelMethod } from './auth-callback-tunnel'
import {
  createHostAgentSignInStatusChecker,
  hostSelection,
  runAgentLogoutCommand,
  type HostAgentSignInStatusChecker
} from '../../../agent-session/environment/host-agent-sign-in-status'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  HostAgentSignInStatusParams,
  HostAgentSignOutParams
} from '../../../../../shared/rpc-contract/accounts-params'

const checkers = new WeakMap<OrcaRuntimeService, HostAgentSignInStatusChecker>()
function checkerFor(runtime: OrcaRuntimeService): HostAgentSignInStatusChecker {
  let checker = checkers.get(runtime)
  if (!checker) {
    checker = createHostAgentSignInStatusChecker(() => runtime.getAccountsSnapshot())
    checkers.set(runtime, checker)
  }
  return checker
}

function selectedHostAccountId(
  runtime: OrcaRuntimeService,
  agent: 'claude' | 'codex'
): string | null {
  try {
    const state = runtime.getAccountsSnapshot()[agent]
    const id = hostSelection(state)
    const account = state.accounts.find((entry) => entry.id === id)
    // An account riding the system-default login has none of its own; the CLI's is what signs in.
    return account && !('runsOnSystemDefault' in account && account.runsOnSystemDefault)
      ? account.id
      : null
  } catch {
    // No account services here: the CLI's own login is the only one.
    return null
  }
}

// Verdicts only: CLI output and credentials stay on this host.
export const agentSignInMethods = (
  flowsFor: (runtime: OrcaRuntimeService) => HostAccountSignInFlows,
  ownerOf: (ctx: Pick<RpcContext, 'caller'>) => string
) => [
  defineMethod({
    name: 'accounts.agentSignInStatus',
    permission: 'workspace',
    params: HostAgentSignInStatusParams,
    handler: async ({ force }, { runtime }) => checkerFor(runtime).read(force === true)
  }),
  // Signs out the login launches here use: the selected Orca account, else the CLI's own.
  defineMethod({
    name: 'accounts.agentSignOut',
    permission: 'accounts-admin',
    params: HostAgentSignOutParams,
    handler: async ({ agent }, { runtime }) => {
      const accountId = selectedHostAccountId(runtime, agent)
      if (accountId) {
        await (agent === 'claude'
          ? runtime.removeClaudeAccount(accountId)
          : runtime.removeCodexAccount(accountId))
      } else {
        await runAgentLogoutCommand(agent)
      }
      return checkerFor(runtime).read(true)
    }
  }),
  createAuthCallbackTunnelMethod(flowsFor, ownerOf)
]
