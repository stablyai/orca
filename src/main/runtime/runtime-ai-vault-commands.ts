import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import {
  listAiVaultSessions,
  readAiVaultSearchCoverage,
  searchAiVaultSessions
} from '../ai-vault/cached-session-list'
import {
  applyAiVaultSearchSettings,
  readAiVaultSearchIndexStatus
} from '../ai-vault-search/session-search-enablement'
import {
  normalizeAiVaultSearchHistoryDays,
  resolveAiVaultSearchSettings,
  type AiVaultSearchIndexStatus
} from '../../shared/ai-vault-search-settings'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'

export type AiVaultSessionSearchConfigureArgs = {
  enabled?: boolean
  historyDays?: number | null
  clearIndex?: boolean
}

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null,
    private readonly getStore: () => RuntimeStore | null = () => null
  ) {}

  list(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    return listAiVaultSessions(args)
  }

  search(args: AiVaultSearchArgs, signal?: AbortSignal): Promise<AiVaultSearchResult> {
    return searchAiVaultSessions(args, { signal })
  }

  searchCoverage(signal?: AbortSignal): Promise<AiVaultSearchCoverage> {
    return readAiVaultSearchCoverage({ signal })
  }

  searchIndexStatus(): AiVaultSearchIndexStatus {
    return readAiVaultSearchIndexStatus()
  }

  /**
   * Persists the consent/retention choice, then pushes it into the running
   * scanner. Enabling here is what starts the backfill for `orca search --enable`.
   */
  async configureSearch(
    args: AiVaultSessionSearchConfigureArgs
  ): Promise<AiVaultSearchIndexStatus> {
    const store = this.getStore()
    if (!store?.getSettings || !store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = resolveAiVaultSearchSettings(store.getSettings())
    const next = {
      enabled: args.enabled ?? current.enabled,
      historyDays:
        args.historyDays === undefined
          ? current.historyDays
          : normalizeAiVaultSearchHistoryDays(args.historyDays)
    }
    store.updateSettings({ aiVaultSearch: next }, { notifyListeners: true })
    await applyAiVaultSearchSettings({ aiVaultSearch: next }, { clearIndex: args.clearIndex })
    return { ...next, indexSizeBytes: readAiVaultSearchIndexStatus().indexSizeBytes }
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }
}
