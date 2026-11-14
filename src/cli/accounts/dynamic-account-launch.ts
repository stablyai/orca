import type { HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import { formatAccountsBlock } from './account-list-format'

export type ClaudeCodexSnapshot = {
  claude: ClaudeRateLimitAccountsState & { dynamic?: boolean }
  codex: CodexRateLimitAccountsState & { dynamic?: boolean }
}

/** `--account dynamic [--off]` for Claude or Codex; false for any other selection. */
export async function selectDynamicLaunch(
  { client, flags, json }: HandlerContext,
  agent: string,
  query: string
): Promise<boolean> {
  if (query !== 'dynamic' || (agent !== 'claude' && agent !== 'codex')) {
    if (flags.has('off')) {
      throw new RuntimeClientError('invalid_argument', '--off only applies to --account dynamic.')
    }
    return false
  }
  const response = await client.call<ClaudeCodexSnapshot>('accounts.list', { refreshUsage: false })
  // Older hosts omit `dynamic`, and their strict settings.update would reject the key.
  if (response.result[agent].dynamic === undefined) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update or restart this Orca host to pick an account for each launch.'
    )
  }
  const dynamic = !flags.has('off')
  await client.call(
    'settings.update',
    agent === 'claude'
      ? { claudeDynamicAccountLaunch: dynamic }
      : { codexDynamicAccountLaunch: dynamic }
  )
  printResult({ ...response, result: { ...response.result[agent], dynamic } }, json, (state) =>
    formatAccountsBlock(agent === 'claude' ? 'Claude' : 'Codex', state)
  )
  return true
}
