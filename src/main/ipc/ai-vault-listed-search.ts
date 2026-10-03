import { ipcMain } from 'electron'
import type {
  AiVaultRankSessionsArgs,
  AiVaultRankSessionsResult
} from '../../shared/ai-vault-session-ai-query'
import type {
  AiVaultSearchSessionsArgs,
  AiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'
import {
  rankListedAiVaultSessions,
  searchListedAiVaultSessions,
  type ListedSessionSearchOptions
} from '../ai-vault/listed-session-search'

export function registerAiVaultListedSearchHandlers(options: ListedSessionSearchOptions): void {
  ipcMain.handle(
    'aiVault:rankSessions',
    (_event, args: AiVaultRankSessionsArgs): Promise<AiVaultRankSessionsResult> =>
      rankListedAiVaultSessions(args, options)
  )
  // Why: main's `aiVault:searchSessions` is the host-scoped index. Listed-file
  // rg/FTS for Session History scopes uses this sibling channel.
  ipcMain.handle(
    'aiVault:searchListedSessions',
    (_event, args: AiVaultSearchSessionsArgs): Promise<AiVaultSearchSessionsResult> =>
      searchListedAiVaultSessions(args)
  )
}
