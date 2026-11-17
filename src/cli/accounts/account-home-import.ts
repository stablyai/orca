import { resolve } from 'node:path'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/agent-accounts/managed-account-types'
import { assertAccountImportSupported } from './account-import-capability'
import { getWslAccountTarget } from './account-wsl-location'
import { formatAccountsBlock } from './account-list-format'

export async function importAccountHome(ctx: HandlerContext, agent: string): Promise<boolean> {
  const sourceHome = ctx.flags.get('home')
  if (sourceHome === undefined && !ctx.flags.has('import-history')) {
    return false
  }
  if (
    (agent !== 'codex' && agent !== 'claude') ||
    typeof sourceHome !== 'string' ||
    !sourceHome.trim()
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--home requires a directory path and --agent claude or codex.'
    )
  }
  const target = getWslAccountTarget(ctx.cwd)
  if (agent === 'claude' && target?.runtime === 'wsl') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Import Claude homes on their native host. Use account add --agent claude to sign in to WSL.'
    )
  }
  await assertAccountImportSupported(ctx, agent)
  const result = await ctx.client.call<ClaudeRateLimitAccountsState | CodexRateLimitAccountsState>(
    agent === 'claude' ? 'accounts.addClaudeFromHome' : 'accounts.addCodexFromHome',
    {
      sourceHome: resolve(ctx.cwd, sourceHome.trim()),
      importHistory: ctx.flags.get('import-history') === true,
      ...(agent === 'codex' ? target : {})
    }
  )
  printResult(result, ctx.json, (state) =>
    formatAccountsBlock(agent === 'claude' ? 'Claude' : 'Codex', state)
  )
  return true
}
