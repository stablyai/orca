import type { CommandHandler } from '../dispatch'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  frozenDefaultRecoveryArgs,
  parseCliAgent,
  readCliAgentLaunch,
  rejectDefaultLaunchRetry,
  resolveCliDefaultAgent
} from '../agent-launch-request'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'
import { resolveCurrentAgentWorkspaceSelector } from '../agent-workspace-selector'

export const AGENT_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'agent launch': async ({ flags, client, cwd, json, rawArgs }) => {
    const requestedAgent = getRequiredStringFlag(flags, 'agent')
    if (requestedAgent === 'default') {
      rejectDefaultLaunchRetry(flags)
    }
    const explicitLaunch =
      requestedAgent === 'default'
        ? undefined
        : readCliAgentLaunch(flags, parseCliAgent(requestedAgent), { createsWorktree: false })
    if (client.isRemote && !flags.has('worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Remote agent launch requires --worktree because the client cwd cannot identify a server worktree.'
      )
    }
    const selector = flags.get('worktree')
    const current = selector === undefined || selector === 'active' || selector === 'current'
    const worktree = current
      ? await resolveCurrentAgentWorkspaceSelector(cwd, client)
      : await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const capabilities = await getAgentLaunchCapabilities(client)
    if (!capabilities) {
      if (flags.has('retry-launch')) {
        throw new RuntimeClientError(
          'agent_session_operation_unknown',
          'This host cannot replay the earlier launch. Return to the original execution host; do not retry without --retry-launch.'
        )
      }
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start agents from the CLI. Update Orca on the execution host.'
      )
    }
    const resolvedAgent =
      requestedAgent === 'default'
        ? await resolveCliDefaultAgent(client, { worktree }, capabilities)
        : undefined
    const launch = resolvedAgent
      ? readCliAgentLaunch(flags, resolvedAgent.agent, { createsWorktree: false })
      : explicitLaunch
    if (!launch) {
      throw new RuntimeClientError('invalid_argument', 'Missing --agent for agent launch.')
    }
    const result = await callAgentLaunch(
      client,
      launch,
      {
        target: { kind: 'existing', worktree },
        presentation: flags.get('focus') === true ? 'focused' : 'background'
      },
      capabilities,
      resolvedAgent ? frozenDefaultRecoveryArgs(rawArgs, resolvedAgent.agent) : rawArgs
    )
    const confirmed = {
      ...result,
      result: { ...result.result, ...(resolvedAgent ? { resolvedAgent } : {}) }
    }
    printResult(confirmed, json, formatAgentLaunch)
  }
}
