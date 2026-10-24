import type { CommandHandler } from '../dispatch'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch,
  rejectDefaultAgentRetry,
  resolveCliAgent,
  withLaunchedAgent
} from '../agent-launch-request'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'
import { resolveCurrentAgentWorkspaceSelector } from '../agent-workspace-selector'

export const AGENT_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'agent launch': async ({ flags, client, cwd, json, rawArgs }) => {
    const requestedAgent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
    rejectDefaultAgentRetry(flags, requestedAgent)
    // Read before any request, so a bad prompt, model or effort reaches no host. `default` is read
    // once the host names the agent, still before anything starts.
    const explicitLaunch =
      requestedAgent === 'default'
        ? undefined
        : readCliAgentLaunch(flags, requestedAgent, { createsWorktree: false })
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
      if (explicitLaunch?.operationId) {
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
    const launchedAgent = await resolveCliAgent(client, requestedAgent, {
      kind: 'existing',
      worktree
    })
    const launch =
      explicitLaunch ?? readCliAgentLaunch(flags, launchedAgent.agent, { createsWorktree: false })
    const result = await callAgentLaunch(
      client,
      launch,
      {
        target: { kind: 'existing', worktree },
        presentation: flags.get('focus') === true ? 'focused' : 'background'
      },
      capabilities,
      rawArgs
    )
    printResult(
      { ...result, result: withLaunchedAgent(result.result, launchedAgent) },
      json,
      formatAgentLaunch
    )
  }
}
