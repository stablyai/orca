import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import type { ClaudeSessionMoverSetting } from '../../shared/claude-account-switch-settings'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'

const SETTINGS: readonly ClaudeSessionMoverSetting[] = ['off', 'ask', 'move']

/**
 * `orca account session-mover --agent claude --off|--ask|--move`: writes the host setting behind
 * Settings › Accounts › Claude › "Move running sessions before a usage limit".
 *
 * Why no remote-flag rejection: the mover acts on the sessions of the runtime it is written on, so
 * `--environment <server>` is the one way to set it for a headless Orca server.
 */
export async function setClaudeSessionMover(ctx: HandlerContext): Promise<void> {
  const agent = ctx.flags.get('agent') ?? 'claude'
  if (agent !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Only --agent claude supports session-mover today.'
    )
  }
  const picked = SETTINGS.filter((setting) => ctx.flags.get(setting) === true)
  if (picked.length !== 1) {
    throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --off, --ask or --move.')
  }
  const result = await ctx.client.call<ClaudeRateLimitAccountsState>(
    'accounts.setClaudeSessionMover',
    {
      setting: picked[0]
    }
  )
  const setting = result.result.sessionMover ?? picked[0]
  if (ctx.json) {
    console.log(JSON.stringify({ sessionMover: setting }, null, 2))
    return
  }
  console.log(`Claude session-mover: ${setting}`)
}
