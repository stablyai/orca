import { defineMethod, type RpcContext } from '../../core'
import type { HostAccountSignInFlows } from '../../../agent-session/environment/host-account-sign-in-flows'
import { createAuthCallbackTunnelMethod } from './auth-callback-tunnel'
import { loopbackCallbackTunnelMethod } from './loopback-callback-tunnel'
import {
  agentLaunchLoginEnv,
  createHostAgentSignInStatusChecker,
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
    checker = createHostAgentSignInStatusChecker(
      () => runtime.getAccountsSnapshot(),
      () => runtime.getHostCodexLaunchHome()
    )
    checkers.set(runtime, checker)
  }
  return checker
}

function readAccounts(runtime: OrcaRuntimeService) {
  try {
    return runtime.getAccountsSnapshot()
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
  // A plain logout of the login launches here use; Orca's saved accounts stay listed.
  defineMethod({
    name: 'accounts.agentSignOut',
    permission: 'accounts-admin',
    params: HostAgentSignOutParams,
    handler: async ({ agent }, { runtime }) => {
      await runAgentLogoutCommand(
        agent,
        agentLaunchLoginEnv(agent, readAccounts(runtime), () => runtime.getHostCodexLaunchHome())
      )
      return checkerFor(runtime).read(true)
    }
  }),
  createAuthCallbackTunnelMethod(flowsFor, ownerOf),
  loopbackCallbackTunnelMethod
]
