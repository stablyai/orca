import { defineMethod } from '../../core'
import {
  createHostAgentSignInStatusChecker,
  type HostAgentSignInStatusChecker
} from '../../../agent-session/environment/host-agent-sign-in-status'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { HostAgentSignInStatusParams } from '../../../../../shared/rpc-contract/accounts-params'

const checkers = new WeakMap<OrcaRuntimeService, HostAgentSignInStatusChecker>()
function checkerFor(runtime: OrcaRuntimeService): HostAgentSignInStatusChecker {
  let checker = checkers.get(runtime)
  if (!checker) {
    checker = createHostAgentSignInStatusChecker(() => runtime.getAccountsSnapshot())
    checkers.set(runtime, checker)
  }
  return checker
}

// Verdicts only: CLI output and credentials stay on this host.
export const AGENT_SIGN_IN_STATUS_METHOD = defineMethod({
  name: 'accounts.agentSignInStatus',
  permission: 'workspace',
  params: HostAgentSignInStatusParams,
  handler: async ({ force }, { runtime }) => checkerFor(runtime).read(force === true)
})
