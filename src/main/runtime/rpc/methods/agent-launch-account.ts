/** `agent.launch`'s `account`: resolved into the launch's own Claude env before anything starts. */

import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import {
  CLAUDE_LAUNCH_ACCOUNT_ENV,
  CLAUDE_LAUNCH_ACCOUNT_HOST_ONLY_MESSAGE,
  CLAUDE_SYSTEM_ACCOUNT
} from '../../../../shared/claude-profile-routing'
import type { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import type { RuntimeRepoSelector } from '../../runtime-repo-selector'
import { InvalidArgumentError, type RpcContext } from '../core'
import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'
import { worktreeCreateRepoSelector } from './worktree-create-args'

type Connected = Promise<{ connectionId?: string | null }>

/** Only where the target runs; the runtime's richer answers fit. */
export type LaunchTargetRuntime = {
  showTerminalWorkspaceLaunchScope: (selector: string) => Connected
  showRepo: (selector: RuntimeRepoSelector) => Connected
}

export type LaunchAccountRouter = Pick<ClaudeProfileRouter, 'savedAccount' | 'pinnedLaunchEnv'>

async function targetConnectionId(
  target: AgentLaunchParams['target'],
  runtime: LaunchTargetRuntime
): Promise<string | null | undefined> {
  if (target.kind === 'existing') {
    return (await runtime.showTerminalWorkspaceLaunchScope(target.worktree)).connectionId
  }
  if (target.kind === 'create-worktree') {
    return (await runtime.showRepo(worktreeCreateRepoSelector(target.create))).connectionId
  }
  return target.create.connectionId
}

/** Refuse what the account cannot reach; otherwise carry its env as the launch's `accountEnv`. */
export async function withLaunchAccount<Params extends AgentLaunchParams>(
  params: Params,
  runtime: LaunchTargetRuntime,
  router: LaunchAccountRouter | undefined = getClaudeProfileRouter()
): Promise<Params> {
  const { account } = params
  if (account === undefined) {
    return params
  }
  if (params.agent !== 'claude') {
    throw new InvalidArgumentError('--account is supported for Claude launches only.')
  }
  if (params.surface !== 'terminal' || params.reuseTerminal) {
    throw new InvalidArgumentError(
      '--account starts Claude in a new terminal; pass --surface terminal.'
    )
  }
  if (!router) {
    throw new InvalidArgumentError('This Orca host does not manage Claude accounts.')
  }
  if (await targetConnectionId(params.target, runtime)) {
    throw new InvalidArgumentError(CLAUDE_LAUNCH_ACCOUNT_HOST_ONLY_MESSAGE)
  }
  const system = account === CLAUDE_SYSTEM_ACCOUNT
  if (!system && !router.savedAccount(account)) {
    throw new InvalidArgumentError(
      `No Claude account ${account} on this host. Run \`orca account list\` for the ids.`
    )
  }
  const env = await router.pinnedLaunchEnv(system ? null : account)
  if (!env) {
    throw new InvalidArgumentError(
      `Claude account ${account} is signed out. Sign in to it in Orca, or choose another account.`
    )
  }
  return { ...params, accountEnv: { ...env, [CLAUDE_LAUNCH_ACCOUNT_ENV]: account } }
}

/** Authorize the target, then resolve the account: both refuse before anything starts. */
export function admitAgentLaunchTarget<Params extends AgentLaunchParams>(
  params: Params,
  context: RpcContext
): Promise<Params> {
  assertAgentLaunchTargetAuthorized(params.target, context)
  return withLaunchAccount(params, context.runtime)
}
