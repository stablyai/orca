import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import type {
  RecordedAgentSession,
  RecordedAgentSessionResume
} from '../../shared/agent-session/recorded-agent-session'

async function workspace(ctx: HandlerContext): Promise<string> {
  if (ctx.client.isRemote && !ctx.flags.has('worktree')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote agent session commands require --worktree; the client cwd cannot identify a server workspace.'
    )
  }
  return ctx.flags.has('worktree')
    ? getRequiredWorktreeSelector(ctx.flags, 'worktree', ctx.cwd, ctx.client)
    : resolveCurrentWorktreeSelector(ctx.cwd, ctx.client)
}

export const AGENT_RESUME_HANDLERS: Record<string, CommandHandler> = {
  'agent sessions': async (ctx) => {
    const result = await ctx.client.call<{ sessions: RecordedAgentSession[] }>('agent.sessions', {
      worktree: await workspace(ctx)
    })
    printResult(
      result,
      ctx.json,
      ({ sessions }) =>
        sessions
          .map(
            (entry) =>
              `${entry.agent} ${entry.providerSession.id}  ${entry.connected ? 'connected' : 'stopped'}  ${entry.paneKey}`
          )
          .join('\n') || 'No recorded terminal conversations in this workspace.'
    )
  },
  'agent resume': async (ctx) => {
    const paneKey = getOptionalStringFlag(ctx.flags, 'pane')
    const agent = getOptionalStringFlag(ctx.flags, 'agent')
    const sessionId = getOptionalStringFlag(ctx.flags, 'session')
    if (!paneKey && !(agent && sessionId)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Specify --pane, or both --agent and --session.'
      )
    }
    const result = await ctx.client.call<RecordedAgentSessionResume>('agent.resume', {
      worktree: await workspace(ctx),
      ...(paneKey ? { paneKey } : {}),
      ...(agent ? { agent } : {}),
      ...(sessionId ? { sessionId } : {})
    })
    printResult(
      result,
      ctx.json,
      (entry) =>
        `${entry.disposition}: ${entry.agent} ${entry.providerSession.id}\npane: ${entry.paneKey}\nterminal: ${entry.handle}`
    )
  }
}
