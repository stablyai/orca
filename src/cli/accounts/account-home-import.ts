import { resolve } from 'node:path'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import { isWindowsAbsolutePathLike } from '../../shared/file-access/cross-platform-path'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/agent-accounts/managed-account-types'
import { assertAccountImportSupported } from './account-import-capability'
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
  const source =
    isWindowsAbsolutePathLike(sourceHome) || sourceHome.startsWith('/')
      ? sourceHome
      : resolve(ctx.cwd, sourceHome)
  const wsl = parseWslUncPath(source)
  const target = wsl
    ? { runtime: 'wsl' as const, wslDistro: wsl.distro }
    : { runtime: 'host' as const }
  const historyFlag = ctx.flags.get('import-history')
  if (
    historyFlag !== undefined &&
    historyFlag !== true &&
    historyFlag !== 'true' &&
    historyFlag !== 'false'
  ) {
    throw new RuntimeClientError('invalid_argument', '--import-history accepts only true or false.')
  }
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
      sourceHome: source,
      importHistory: historyFlag === true || historyFlag === 'true',
      ...(agent === 'codex' ? target : {})
    },
    { timeoutMs: 30 * 60_000 }
  )
  printResult(result, ctx.json, (state) =>
    formatAccountsBlock(agent === 'claude' ? 'Claude' : 'Codex', state)
  )
  return true
}
