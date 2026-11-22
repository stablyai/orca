import { resolve } from 'node:path'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import type { CodexRateLimitAccountsState } from '../../shared/agent-accounts/managed-account-types'
import { isWindowsAbsolutePathLike } from '../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import { assertAccountImportSupported } from './account-import-capability'
import { formatAccountsBlock } from './account-list-format'

export async function importAccountHome(ctx: HandlerContext, agent: string): Promise<boolean> {
  const sourceHome = ctx.flags.get('home')
  if (sourceHome === undefined) {
    return false
  }
  if (agent !== 'codex' || typeof sourceHome !== 'string' || !sourceHome.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--home requires a directory path and --agent codex.'
    )
  }
  const source =
    isWindowsAbsolutePathLike(sourceHome) || sourceHome.startsWith('/')
      ? sourceHome
      : resolve(ctx.cwd, sourceHome)
  const wsl = parseWslUncPath(source)
  await assertAccountImportSupported(ctx, 'codex')
  const result = await ctx.client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
    sourceHome: source,
    runtime: wsl ? 'wsl' : 'host',
    wslDistro: wsl?.distro ?? null
  })
  printResult(result, ctx.json, (state) => formatAccountsBlock('Codex', state))
  return true
}
