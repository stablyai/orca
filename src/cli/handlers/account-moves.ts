import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { formatClaudeSessionMoveLine } from '../../shared/claude-session-move-line'
import type { ClaudeSessionMoveSummary } from '../../shared/managed-account-types'

type MovesSnapshot = {
  claude: {
    sessionMoves?: readonly ClaudeSessionMoveSummary[]
  }
}

/**
 * `orca account moves`: prints the mover's last decision per live Claude session.
 *
 * Why no remote-flag rejection: the decisions belong to the runtime that moved
 * the sessions, so `--environment <server>` reads that server.
 */
export async function printClaudeAccountMoves(ctx: HandlerContext): Promise<void> {
  const agent = ctx.flags.get('agent') ?? 'claude'
  if (agent !== 'claude') {
    throw new RuntimeClientError('invalid_argument', 'Only --agent claude supports moves today.')
  }
  const result = await ctx.client.call<MovesSnapshot>('accounts.list', { refreshUsage: false })
  const moves = result.result.claude.sessionMoves ?? []
  if (ctx.json) {
    console.log(JSON.stringify(moves, null, 2))
    return
  }
  if (moves.length === 0) {
    console.log('No Claude session moves.')
    return
  }
  for (const move of moves) {
    console.log(formatClaudeSessionMoveLine(move))
  }
}
