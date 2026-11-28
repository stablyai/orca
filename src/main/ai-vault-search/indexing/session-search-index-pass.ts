import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  createAntigravityWorkspaceResolver,
  readLocalAntigravityHistory
} from '../../ai-vault/scanners/antigravity/session-scanner-antigravity-history'
import { throwIfAiVaultScanCancelled } from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import { isTranscriptSourceFailure } from '../../ai-vault/parsing/session-scanner-jsonl-reader'
import {
  physicalSessionCandidates,
  type SessionFileCandidate,
  type SessionFileChoice
} from '../../ai-vault/session-scanner-types'
import { fileIdentity } from '../storage/session-search-file-cursor'
import { REMOVALS_PER_FLUSH } from '../discovery/session-search-deleted-sources'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type {
  SessionSearchFileRow,
  SessionSearchIndexStore
} from '../storage/session-search-store-types'

// Older cursors prove byte coverage, not workspace enrichment or readable conversation content.
type AntigravitySnapshot = 'content' | 'empty' | 'suppressed' | AiVaultSession
const verifiedAntigravity = new WeakMap<SessionSearchIndexStore, Map<string, AntigravitySnapshot>>()

export type SessionSearchIndexPassOptions = {
  signal?: AbortSignal
  /** Snapshot of indexed rows; a missing key means the path has no row. */
  rows: ReadonlyMap<string, SessionSearchFileRow>
  /** Stop between files once overdue, but always read one file to avoid starving large transcripts. */
  overdue?: () => boolean
}

/** Deferred candidates stay owed by their stored state; left counts backlog outside the due-row count. */
export async function runSessionSearchIndexPass(
  store: SessionSearchIndexStore,
  candidates: readonly SessionFileChoice[],
  options: SessionSearchIndexPassOptions
): Promise<{ stats: SessionParseStats; outOfTime: boolean; left: number; retired: string[] }> {
  const stats = createSessionParseStats()
  const workspaceResolver = createAntigravityWorkspaceResolver((path) =>
    readLocalAntigravityHistory(path, options.signal)
  )
  const verified = verifiedAntigravity.get(store) ?? new Map<string, AntigravitySnapshot>()
  verifiedAntigravity.set(store, verified)
  for (const path of verified.keys()) {
    if (!options.rows.has(path)) {
      verified.delete(path)
    }
  }
  const cutoffMs = store.retentionCutoff
  const acceptsReads = () => store.acceptingReads !== false
  let read = 0
  let outOfTime = false
  let left = 0
  let heldRemovals = 0
  let retirementOverdue = false
  const retired: string[] = []
  for (const choice of candidates) {
    throwIfAiVaultScanCancelled(options.signal)
    if (!acceptsReads()) {
      break
    }
    let deferred = false
    let due = false
    let admitted = false
    const aliases = physicalSessionCandidates(choice)
    const paired = choice.agent === 'antigravity' && aliases.length === 2
    const retireSibling = (position: number) => {
      const sibling = aliases[1 - position].file.path
      const row = options.rows.get(sibling)
      if (
        row &&
        verified.get(sibling) !== 'suppressed' &&
        !(row.state === 'failed' && row.sizeBytes === null)
      ) {
        store.removeFile(sibling)
        retired.push(sibling)
      }
    }
    for (const [position, candidate] of aliases.entries()) {
      throwIfAiVaultScanCancelled(options.signal)
      if (!acceptsReads()) {
        break
      }
      const path = candidate.file.path
      const row = options.rows.get(path)
      const cursor = row ? store.indexedFile(path, fileIdentity(candidate.file)) : null
      let decision = sessionSearchReadDecision({ candidate, row, cursor, cutoffMs })
      const current =
        row?.state === 'current' &&
        cursor !== null &&
        (cutoffMs === null || candidate.file.mtimeMs >= cutoffMs)
      const snapshot = verified.get(path)
      const historyPath = candidate.antigravityHistoryPath
      if (decision === 'skip' && current && candidate.agent === 'antigravity') {
        let workspaceResolved = false
        // Retry an unresolved workspace from metadata before paying to reread the transcript.
        if (historyPath && typeof snapshot === 'object') {
          try {
            workspaceResolved = !!(await workspaceResolver.enrich(snapshot, historyPath)).cwd
          } catch {
            throwIfAiVaultScanCancelled(options.signal)
          }
        }
        if (workspaceResolved || !snapshot || (paired && position === 0 && snapshot === 'empty')) {
          decision = 'whole'
        }
      }
      if (decision === 'skip') {
        if (current) {
          if (paired) {
            if (deferred || (snapshot !== 'content' && typeof snapshot !== 'object')) {
              continue
            }
            deferred = false
            retireSibling(position)
            break
          }
          deferred = false
          // Later sweeps finish a large first cleanup; the preferred copy stays current.
          const copies = choice.outrankedCopies
          if (position + 1 < aliases.length || copies) {
            const outranked = aliases.slice(position + 1)
            for (const copyPath of retirableAliasRows(options.rows, candidate, outranked, copies)) {
              if (outOfTime || retirementOverdue) {
                break
              }
              store.removeFile(copyPath)
              retired.push(copyPath)
              if (++heldRemovals >= REMOVALS_PER_FLUSH) {
                heldRemovals = 0
                await store.flush?.()
                throwIfAiVaultScanCancelled(options.signal)
                retirementOverdue = options.overdue?.() === true
              }
            }
          }
          break
        }
        continue
      }
      if (!admitted) {
        outOfTime ||= read > 0 && options.overdue?.() === true
      }
      if (outOfTime && !admitted) {
        deferred = true
        due ||= row?.state === 'due'
        continue
      }
      throwIfAiVaultScanCancelled(options.signal)
      if (!acceptsReads()) {
        break
      }
      admitted = true
      read += 1
      let hasMessages = false
      let unresolvedWorkspace: AiVaultSession | null = null
      try {
        const session = await parseAgentSessionFileCached(
          candidate,
          process.platform,
          stats,
          decision,
          options.signal,
          async (session) => {
            if (paired && position === 0 && session.messageCount === 0) {
              return null
            }
            if (!historyPath) {
              return session
            }
            const enriched = await workspaceResolver.enrich(session, historyPath)
            if (!enriched.cwd) {
              unresolvedWorkspace = session
            }
            return enriched
          }
        )
        hasMessages = (session?.messageCount ?? 0) > 0
      } catch (error) {
        throwIfAiVaultScanCancelled(options.signal)
        console.warn(
          '[ai-vault-search] indexing skipped',
          candidate.agent,
          error instanceof Error ? error.name : 'ParseError'
        )
        if (isTranscriptSourceFailure(error)) {
          continue
        }
        break
      }
      // Consumer/store failures cannot authorize reading another physical alias.
      try {
        await store.flush?.()
        if (candidate.agent === 'antigravity') {
          const covered = store.coversTranscript(candidate)
          if (covered) {
            verified.set(
              path,
              hasMessages
                ? (unresolvedWorkspace ?? 'content')
                : paired && position === 0
                  ? 'suppressed'
                  : 'empty'
            )
          }
          if (paired) {
            if (!hasMessages) {
              continue
            }
            if (!covered) {
              break
            }
            retireSibling(position)
          }
        }
      } catch (error) {
        throwIfAiVaultScanCancelled(options.signal)
        console.warn(
          '[ai-vault-search] indexing skipped',
          candidate.agent,
          error instanceof Error ? error.name : 'FlushError'
        )
      }
      break
    }
    if (deferred && !due) {
      left += 1
    }
  }
  return { stats, outOfTime, left, retired }
}

/** Hardlinks, moves and Codex archives keep mtime; same-format copies must also match size. */
function* retirableAliasRows(
  rows: ReadonlyMap<string, SessionSearchFileRow>,
  preferred: SessionFileCandidate,
  ...outranked: (readonly SessionFileCandidate[] | undefined)[]
): Generator<string> {
  for (const copies of outranked) {
    for (const copy of copies ?? []) {
      if (
        copy.file.path !== preferred.file.path &&
        rows.has(copy.file.path) &&
        copy.file.mtimeMs === preferred.file.mtimeMs &&
        (copy.file.path.endsWith('.zst') !== preferred.file.path.endsWith('.zst') ||
          copy.file.sizeBytes === preferred.file.sizeBytes)
      ) {
        yield copy.file.path
      }
    }
  }
}
