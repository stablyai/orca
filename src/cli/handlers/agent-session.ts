import { randomBytes } from 'node:crypto'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { RuntimeTerminalClose, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

function formatSession(session: AiVaultSession): string {
  const project = session.project?.displayName ?? 'Unassigned'
  const state = session.liveTerminalHandle ? 'live' : 'history'
  return `${session.id}\t${state}\t${session.agent}\t${project}\t${session.title}`
}

async function selectedWorktree(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  const explicit = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
  if (explicit) {
    return explicit
  }
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote agent sessions require an explicit --worktree selector.'
    )
  }
  return resolveCurrentWorktreeSelector(cwd, client)
}

async function selectedAgent(
  flags: Map<string, string | boolean>,
  client: Parameters<CommandHandler>[0]['client']
): Promise<TuiAgent> {
  const explicit = getOptionalStringFlag(flags, 'agent')
  const settings = explicit
    ? null
    : await client.call<{
        settings: { defaultTuiAgent?: string | null; disabledTuiAgents?: string[] }
      }>('settings.get')
  const agent = explicit ?? settings?.result.settings.defaultTuiAgent
  if (!agent || !isTuiAgent(agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'No usable agent was selected. Configure Orca defaultTuiAgent or pass --agent.'
    )
  }
  if (settings?.result.settings.disabledTuiAgents?.includes(agent)) {
    throw new RuntimeClientError('invalid_argument', `The default agent "${agent}" is disabled.`)
  }
  return agent
}

export const AGENT_SESSION_HANDLERS: Record<string, CommandHandler> = {
  'agent session start': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RuntimeCreateAgentSessionResult>(
      'terminal.createAgentSession',
      {
        clientOperationId: `${Date.now()}-${randomBytes(16).toString('hex')}`,
        worktree: await selectedWorktree(flags, cwd, client),
        agent: await selectedAgent(flags, client),
        prompt: getOptionalStringFlag(flags, 'prompt'),
        presentation: flags.get('focus') === true ? 'focused' : 'background',
        viewMode: 'chat'
      }
    )
    printResult(result, json, (value) => value.terminal.handle)
  },
  'agent session list': async ({ flags, client, cwd, json }) => {
    const state = getOptionalStringFlag(flags, 'state') ?? 'all'
    if (!['live', 'history', 'all'].includes(state)) {
      throw new RuntimeClientError('invalid_argument', '--state must be live, history, or all')
    }
    const response = await client.call<AiVaultListResult>('agentSession.list', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    const project = getOptionalStringFlag(flags, 'project')
    const worktreeSelector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const worktree = worktreeSelector
      ? (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: worktreeSelector
          })
        ).result.worktree
      : null
    const sessions = response.result.sessions.filter(
      (session) =>
        (!project || session.project?.id === project || session.project?.displayName === project) &&
        (!worktree ||
          session.project?.originalWorktreeId === worktree.id ||
          session.project?.originalWorktreePath === worktree.path) &&
        (state === 'all' || (state === 'live') === Boolean(session.liveTerminalHandle))
    )
    printResult({ ...response, result: { ...response.result, sessions } }, json, (value) =>
      value.sessions.map(formatSession).join('\n')
    )
  },
  'agent session resume': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RuntimeEnsureAgentSessionResult>('agentSession.resume', {
      sessionId: getRequiredStringFlag(flags, 'session'),
      worktree: await selectedWorktree(flags, cwd, client),
      presentation: flags.get('focus') === true ? 'focused' : 'background'
    })
    printResult(result, json, (value) => value.terminal.handle)
  },
  'agent session stop': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeTerminalClose>('agentSession.stop', {
      sessionId: getRequiredStringFlag(flags, 'session')
    })
    printResult(result, json, (value) => `${value.handle}\tstopped`)
  }
}
