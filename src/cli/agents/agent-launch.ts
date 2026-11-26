import type { CommandHandler } from '../dispatch/dispatch'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch,
  readCliAgentLaunchSplit
} from './agent-launch-request'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'

export const AGENT_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'agent launch': async ({ flags, client, cwd, json, rawArgs }) => {
    const launch = readCliAgentLaunch(flags, parseCliAgent(getRequiredStringFlag(flags, 'agent')), {
      createsWorktree: false
    })
    const split = readCliAgentLaunchSplit(flags, process.env)
    if (split && (client.isRemote || launch.surface === 'terminal')) {
      throw new RuntimeClientError(
        'invalid_argument',
        client.isRemote
          ? '--split places the chat beside your tab in this Orca window; it does not work with a remote host.'
          : '--split opens a chat; it does not work with --surface terminal.'
      )
    }
    if (client.isRemote && !flags.has('worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Remote agent launch requires --worktree because the client cwd cannot identify a server worktree.'
      )
    }
    const selector = flags.get('worktree')
    const current = selector === undefined || selector === 'active' || selector === 'current'
    const worktree = current
      ? await resolveCurrentWorktreeSelector(cwd, client, { agent: launch.agent })
      : await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const capabilities = await getAgentLaunchCapabilities(client)
    if (!capabilities) {
      if (launch.operationId) {
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
    const result = await callAgentLaunch(
      client,
      split ? { ...launch, surface: 'chat' } : launch,
      {
        target: { kind: 'existing', worktree },
        presentation: flags.get('focus') === true ? 'focused' : 'background',
        ...(split ? { placement: { split } } : {})
      },
      capabilities,
      rawArgs
    )
    printResult(result, json, formatAgentLaunch)
  }
}
