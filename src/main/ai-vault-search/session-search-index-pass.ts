import type { SessionSearchCandidateInventory } from './session-search-candidate-inventory'
import {
  getSessionParseCacheEntry,
  sessionParseCacheKey
} from '../ai-vault/parse-cache/session-parse-cache-store'
import { SessionSearchIndexConsumer } from './session-search-index-consumer'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../ai-vault/parse-cache/session-scanner-parse-cache'
import { fileIdentity } from './session-search-file-cursor'
import {
  sessionSearchReadDecision,
  SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT
} from './session-search-read-decision'
import type { SessionSearchIndexStore } from './session-search-store'
import type { SessionSearchWork, SessionSearchWorkQueue } from './session-search-work-queue'

export async function runSessionSearchIndexPass(
  store: SessionSearchIndexStore,
  queue: SessionSearchWorkQueue,
  options: {
    signal?: AbortSignal
    overdue?: () => boolean
    publications?: SessionSearchCandidateInventory
    admit?: (work: SessionSearchWork) => Promise<SessionSearchWork | undefined>
  }
): Promise<{ stats: SessionParseStats; outOfTime: boolean; left: number }> {
  const stats = createSessionParseStats()
  // Retry once per cycle; rotating the failed path cannot monopolize a pass.
  const available = queue.size
  let consumed = 0
  let outOfTime = false
  while (consumed < available && queue.size) {
    throwIfAiVaultScanCancelled(options.signal)
    if (consumed > 0 && options.overdue?.()) {
      outOfTime = true
      break
    }
    let work = await queue.next()
    if (!work) {
      break
    }
    if (options.admit) {
      work = await options.admit(work)
      if (!work) {
        consumed++
        continue
      }
    }
    const { candidate } = work
    const path = candidate.file.path
    await store.prepareCoverage?.([path])
    let row = store.fileRow(path)
    const cursor = row ? store.indexedFile(path, fileIdentity(candidate.file)) : null
    const entry = work.metadata
      ? getSessionParseCacheEntry(sessionParseCacheKey(candidate.agent, path))
      : undefined
    if (
      work.metadata &&
      !work.force &&
      row?.agent &&
      row.prefixHash &&
      row.byteOffset !== undefined &&
      row.byteOffset !== null &&
      (row.state === 'current' ||
        (row.state === 'failed' && row.failCount < SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT)) &&
      row.mtimeMs === candidate.file.mtimeMs &&
      row.sizeBytes === candidate.file.sizeBytes &&
      entry?.foldSession !== undefined &&
      entry.platform === process.platform &&
      entry.mtimeMs === candidate.file.mtimeMs &&
      entry.sizeBytes === candidate.file.sizeBytes
    ) {
      const session = await parseAgentSessionFileCached(
        candidate,
        process.platform,
        stats,
        undefined,
        options.signal,
        true
      )
      let published: SessionSearchFileWrite | undefined
      const consumer = new SessionSearchIndexConsumer(
        store,
        (write) => {
          published = write
        },
        options.publications
      ).beginRead({
        candidate,
        mode: 'append',
        previousByteOffset: row.byteOffset,
        indexing: true,
        metadataOnly: true,
        signal: options.signal
      })
      if (consumer) {
        await consumer.finish({
          session,
          byteOffset: row.byteOffset,
          prefixHash: row.prefixHash,
          incomplete: false
        })
        await store.flush?.()
        if (
          published &&
          !published.failed?.() &&
          !published.cancelled?.() &&
          store.fileRow(path)?.state === 'current'
        ) {
          await queue.acknowledge(work, false)
          consumed++
          continue
        }
      }
      const failed = store.fileRow(path)
      await queue.acknowledge(
        work,
        failed?.state !== 'failed' || failed.failCount < SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT
      )
      consumed++
      continue
    }
    // Equal-stat writes and dependency edits cannot use coverage of the old input as a skip gate.
    if (
      work.force &&
      row?.state === 'current' &&
      row.mtimeMs === candidate.file.mtimeMs &&
      (row.sizeBytes === null ||
        candidate.file.sizeBytes === undefined ||
        row.sizeBytes === candidate.file.sizeBytes)
    ) {
      store.setFileState(path, 'due')
      await store.flush?.()
      row = store.fileRow(path)
    }
    let decision = sessionSearchReadDecision({
      candidate,
      row,
      cursor,
      cutoffMs: store.retentionCutoff
    })
    if (
      decision === 'skip' &&
      work.metadata &&
      row?.state === 'current' &&
      (store.retentionCutoff === null || candidate.file.mtimeMs >= store.retentionCutoff)
    ) {
      decision = 'any'
    }
    consumed++
    if (decision === 'skip') {
      await queue.acknowledge(work, false)
      continue
    }
    const failuresBeforeRead = row?.failCount ?? 0
    try {
      await parseAgentSessionFileCached(
        candidate,
        process.platform,
        stats,
        decision,
        options.signal,
        true
      )
      await store.flush?.()
    } catch (error) {
      throwIfAiVaultScanCancelled(options.signal)
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      console.warn(
        '[ai-vault-search] indexing skipped',
        candidate.agent,
        error instanceof Error ? error.name : 'ParseError'
      )
      // The attached transcript consumer may already have settled this failed attempt.
      await store.flush?.()
      if ((store.fileRow(path)?.failCount ?? 0) <= failuresBeforeRead) {
        store.setFileState(path, 'failed', candidate.file.mtimeMs)
      }
      await store.flush?.()
    }
    const committed = store.fileRow(path)
    const remaining = sessionSearchReadDecision({
      candidate,
      row: committed,
      cursor: committed ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
      cutoffMs: store.retentionCutoff
    })
    await queue.acknowledge(work, remaining !== 'skip')
    await queue.rowChanged(path, committed)
  }
  return { stats, outOfTime, left: queue.left }
}
