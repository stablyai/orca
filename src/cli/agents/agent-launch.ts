import type { CommandHandler } from '../dispatch/dispatch'
import type { RuntimeEnsureAgentSessionResult } from '../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { AGENT_SESSION_DOUBAO_RESUME_RUNTIME_CAPABILITY } from '../../shared/agent-session/lifecycle/resume/agent-session-resume-runtime-capabilities'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch
} from './agent-launch-request'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'

export const AGENT_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'agent resume': async ({ flags, client, cwd, json }) => {
    const agent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
    if (agent !== 'doubao') {
      throw new RuntimeClientError(
        'invalid_argument',
        'This command currently supports --agent doubao.'
      )
    }
    const id = getRequiredStringFlag(flags, 'session-id')
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    if (
      !(await getAgentLaunchCapabilities(client))?.includes(
        AGENT_SESSION_DOUBAO_RESUME_RUNTIME_CAPABILITY
      )
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the execution host to resume a Doubao session.'
      )
    }
    const result = await client.call<RuntimeEnsureAgentSessionResult>(
      'terminal.ensureAgentSession',
      {
        kind: 'explicit',
        agent,
        providerSession: { key: 'session_id', id },
        worktree,
        presentation: flags.get('focus') === true ? 'focused' : 'background'
      }
    )
    printResult(result, json, ({ terminal, disposition }) => `${terminal.handle} (${disposition})`)
  },
  'agent launch': async ({ flags, client, cwd, json, rawArgs }) => {
    const launch = readCliAgentLaunch(flags, parseCliAgent(getRequiredStringFlag(flags, 'agent')), {
      createsWorktree: false
    })
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
      launch,
      {
        target: { kind: 'existing', worktree },
        presentation: flags.get('focus') === true ? 'focused' : 'background'
      },
      capabilities,
      rawArgs
    )
    printResult(result, json, formatAgentLaunch)
  }
}
