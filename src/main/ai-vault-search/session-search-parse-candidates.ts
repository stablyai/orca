import { inSessionParseFileLane } from '../ai-vault/session-parse-file-lane'
import { refreshCachedCodexMetadata } from '../ai-vault/session-scanner-codex-cached-metadata'
import { getSessionParseCacheEntry } from '../ai-vault/session-parse-cache-store'
import { fileIdentity } from '../ai-vault/session-scanner-resume-point'
import { withCursorChatMetaScan } from '../ai-vault/session-scanner-cursor-chat-meta'
import {
  isSessionSearchFileCurrent,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../ai-vault/session-scanner-parse-cache'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchStore } from './session-search-store'
import { pauseBackfill } from './session-search-backfill-pacing'

export type ParseSearchCandidatesOptions = {
  signal?: AbortSignal
  /** Backfill only: report each file to the progress bar and yield to waiting searches. */
  onFileProcessed?: (failed: boolean) => Promise<void>
}

export async function parseSearchCandidates(
  store: SessionSearchStore,
  candidates: SessionFileCandidate[],
  { signal, onFileProcessed }: ParseSearchCandidatesOptions = {}
): Promise<void> {
  const stats = createSessionParseStats()
  let sinceYield = 0
  await withCursorChatMetaScan(() =>
    withSessionSearchIndexRequired(async () => {
      for (const candidate of candidates) {
        throwIfAiVaultScanCancelled(signal)
        if (!store.acceptsCandidate(candidate)) {
          continue
        }
        const failures = store.failures
        let failed = false
        try {
          // Retain cached metadata refreshes, but a cold index-only pass needs no preview parse.
          if (
            getSessionParseCacheEntry(candidate.file.path) ||
            !isSessionSearchFileCurrent(
              store.indexedFile(candidate.file.path, fileIdentity(candidate.file)),
              candidate.file
            )
          ) {
            await parseAgentSessionFileCached(candidate, process.platform, stats)
          } else if (candidate.agent === 'codex') {
            await inSessionParseFileLane(candidate.file.path, async () => {
              throwIfAiVaultScanCancelled(signal)
              if (
                !store.acceptsCandidate(candidate) ||
                !isSessionSearchFileCurrent(
                  store.indexedFile(candidate.file.path, fileIdentity(candidate.file)),
                  candidate.file
                )
              ) {
                return
              }
              const metadata = store.indexedMetadata(candidate.file.path)
              if (metadata) {
                const refreshed = await refreshCachedCodexMetadata(candidate, metadata)
                throwIfAiVaultScanCancelled(signal)
                if (refreshed !== metadata) {
                  store.updateMetadata(candidate, refreshed)
                }
              }
            })
          }
        } catch (error) {
          throwIfAiVaultScanCancelled(signal)
          failed = true
          store.recordParseFailure(candidate.agent)
          console.warn(
            '[ai-vault-search] backfill skipped',
            candidate.agent,
            error instanceof Error ? error.name : 'ParseError'
          )
        }
        if (onFileProcessed && !signal?.aborted) {
          await onFileProcessed(failed || store.failures > failures)
        }
        sinceYield++
        if (sinceYield >= 8) {
          sinceYield = 0
          await pauseBackfill(signal)
        }
      }
    }, signal)
  )
}
