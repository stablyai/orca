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
import type { IPtyProvider } from '../providers/types'
import { projectSessionSearchResult } from '../../shared/ai-vault-search-projection'
import {
  SESSION_SEARCH_METHODS,
  SessionSearchConfigureSchema,
  SessionSearchQuerySchema,
  type SessionSearchConfigure,
  type SessionSearchOperation
} from '../../shared/ai-vault-search-contract'

export type AiVaultSessionSearchConfigureArgs = SessionSearchConfigure

// Why: `reason` is optional on the wire type, so a host that omits it must not
// surface an `undefined` message.
const SEARCH_UNAVAILABLE_MESSAGE = 'Session search is unavailable on this host.'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null,
    private readonly getStore: () => RuntimeStore | null = () => null,
    private readonly getSshProvider: (targetId: string) => IPtyProvider | undefined = () =>
      undefined
  ) {}

  list(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    return listAiVaultSessions(args)
  }

  search(args: AiVaultSearchArgs, signal?: AbortSignal): Promise<AiVaultSearchResult> {
    const status = this.searchIndexStatus()
    // Why: an in-flight policy apply leaves `applied` false while the existing
    // index is still valid; refusing there would fail every query issued during
    // a settings write. `searchIndexStatus` remains the channel for that.
    if (status.available === false) {
      throw new Error(status.reason ?? SEARCH_UNAVAILABLE_MESSAGE)
    }
    return searchAiVaultSessions(args, { signal }).then(projectSessionSearchResult)
  }

  async sshSearch(
    targetId: string,
    operation: SessionSearchOperation,
    args: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const provider = this.getSshProvider(targetId)
    if (!provider?.requestHostRpc) {
      throw new Error('SSH search unavailable: target is not connected to this runtime.')
    }
    const params =
      operation === 'query'
        ? SessionSearchQuerySchema.parse(args)
        : operation === 'configure'
          ? SessionSearchConfigureSchema.parse(args)
          : {}
    try {
      return await provider.requestHostRpc(SESSION_SEARCH_METHODS[operation].relay, params, {
        signal,
        timeoutMs: 15_000
      })
    } catch (error) {
      if (
        operation === 'status' &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === -32601
      ) {
        return {
          enabled: false,
          historyDays: null,
          indexSizeBytes: null,
          available: false,
          applied: false,
          reason:
            'This SSH relay does not support full-text search. Update the controlling Orca runtime and reconnect the target.'
        }
      }
      throw error
    }
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
    if (
      !store?.getSettings ||
      !store.updateSettings ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      throw new Error('runtime_unavailable')
    }
    const status = this.searchIndexStatus()
    if (status.available === false) {
      throw new Error(status.reason ?? SEARCH_UNAVAILABLE_MESSAGE)
    }
    const current = resolveAiVaultSearchSettings(store.getSettings())
    const next = {
      enabled: args.enabled ?? current.enabled,
      ...((args.paused ?? current.paused) ? { paused: true } : {}),
      historyDays:
        args.historyDays === undefined
          ? current.historyDays
          : normalizeAiVaultSearchHistoryDays(args.historyDays)
    }
    store.updateSettings({ aiVaultSearch: next }, { notifyListeners: true })
    await applyAiVaultSearchSettings(
      { aiVaultSearch: next },
      {
        clearIndex: args.clearIndex,
        persist: async () => {
          if (store.flushPendingOrThrowAsync) {
            await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
          } else {
            store.flushOrThrow!()
          }
        }
      }
    )
    return readAiVaultSearchIndexStatus()
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
