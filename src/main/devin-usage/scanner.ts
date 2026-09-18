import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { devinSessionsIndexForSidecar } from '../ai-vault/session-scanner-devin-db'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { sidecarUnchanged } from '../ai-vault/session-sidecar-stat'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { resolveDevinTranscriptsDir } from '../devin/devin-cli-data-dir'
import {
  getProcessedFileInfo,
  listDevinTranscriptFiles,
  observeDevinSessionsDb
} from './devin-transcript-discovery'
import { parseDevinTranscriptForUsage } from './devin-transcript-parse'
import {
  attributeDevinUsageEvent,
  type DevinUsageWorktreeRef
} from './devin-usage-worktree-attribution'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type {
  DevinUsageAttributedEvent,
  DevinUsageDailyAggregate,
  DevinUsageParsedEvent,
  DevinUsagePersistedFile,
  DevinUsageProcessedFile,
  DevinUsageSession
} from './types'

const YIELD_EVERY_FILES = 2

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

type DevinUsageMetric = { estimatedCostUsd: number | null }

const devinUsageAggregation = createUsageEventAggregation<
  DevinUsageAttributedEvent,
  DevinUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null }),
    fromEvent: (event) => ({ estimatedCostUsd: event.estimatedCostUsd }),
    fold: (target, source) => {
      target.estimatedCostUsd = addCost(target.estimatedCostUsd, source.estimatedCostUsd)
    }
  },
  cloneSessionForMerge: (session) => structuredClone(session)
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  devinUsageAggregation

type ParsedDevinTranscript = {
  file: DevinUsageProcessedFile
  sessionId: string
  hidden: boolean
  events: DevinUsageParsedEvent[]
}

async function readDevinUsageTranscript(
  filePath: string,
  sessionsIndex: ReturnType<typeof devinSessionsIndexForSidecar>['index']
): Promise<ParsedDevinTranscript | null> {
  const file = await getProcessedFileInfo(filePath)
  const content = await wslGatedReadFile(filePath, 'utf-8', 'scan')
  const parsed = parseDevinTranscriptForUsage(filePath, content, sessionsIndex)
  return parsed ? { file, ...parsed } : null
}

export async function scanDevinUsageFiles(
  worktrees: DevinUsageWorktreeRef[],
  previousProcessedFiles: DevinUsagePersistedFile[] = [],
  onFilesScanned?: (count: number) => void
): Promise<{
  processedFiles: DevinUsagePersistedFile[]
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
}> {
  const transcriptsDir = resolveDevinTranscriptsDir()
  const filePaths = await listDevinTranscriptFiles()
  const observedDb = await observeDevinSessionsDb(transcriptsDir)
  const { index: sessionsIndex, unreadable } = devinSessionsIndexForSidecar(observedDb)
  // Why: an observed-but-unreadable db must not settle into the cache — record
  // 'unknown' so the next scan reparses once the db is readable again.
  const sessionsDb = unreadable ? 'unknown' : observedDb
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  // Why: one resolver for the whole scan so every file shares the per-cwd memo.
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const currentPaths = new Set(filePaths)
  // Why: when a file that owned sessions is deleted, remaining copies still
  // carry those sessions but their caches record them as unowned. Only files
  // that previously deferred claims can reclaim.
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedSessionIds) &&
      file.ownedSessionIds.length > 0
  )

  const reusedByPath = new Map<string, DevinUsagePersistedFile>()
  const pathsToParse: string[] = []
  for (const filePath of filePaths) {
    let fileInfo: DevinUsageProcessedFile
    try {
      fileInfo = await getProcessedFileInfo(filePath)
    } catch {
      // A transcript deleted between listing and stat retries next scan.
      continue
    }
    const previous = previousByPath.get(filePath)
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      previous &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      sidecarUnchanged(previous.sessionsDb, sessionsDb) &&
      Array.isArray(previous.ownedSessionIds) &&
      typeof previous.hasDeferredClaims === 'boolean'
    if (canReuse) {
      reusedByPath.set(filePath, previous)
    } else {
      pathsToParse.push(filePath)
    }
  }

  // Why: transcript copies (a duplicated file, a restored backup inside the
  // root) carry the same session_id, so each session is counted from exactly
  // one file. Devin's canonical name is <session_id>.json — a stale copy that
  // claimed a session while the canonical file was absent must hand the claim
  // back once that file reparses, or the live session freezes at the copy's
  // totals (#8006).
  for (const [filePath, reused] of reusedByPath) {
    const hasReclaimable = (reused.ownedSessionIds ?? []).some(
      (sessionId) =>
        sessionIdFromFileName(filePath) !== sessionId &&
        pathsToParse.some((candidate) => sessionIdFromFileName(candidate) === sessionId)
    )
    if (hasReclaimable) {
      reusedByPath.delete(filePath)
      pathsToParse.push(filePath)
    }
  }

  const rawByPath = new Map<string, ParsedDevinTranscript>()
  for (const [index, filePath] of pathsToParse.sort().entries()) {
    try {
      const raw = await readDevinUsageTranscript(filePath, sessionsIndex)
      if (raw) {
        rawByPath.set(filePath, raw)
      }
    } catch {
      // An unreadable transcript must not sink the scan; it retries on the
      // next refresh because it is absent from the persisted cache.
    }

    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  // Why: cached files keep the claims they persisted. Among fresh candidates
  // the canonical <session_id>.json wins; without that, a lexicographically
  // earlier copy ('s1-copy.json' < 's1.json') would claim first and defer the
  // live transcript forever.
  const sessionOwnerById = new Map<string, string>()
  for (const filePath of [...reusedByPath.keys()].sort()) {
    for (const sessionId of reusedByPath.get(filePath)?.ownedSessionIds ?? []) {
      if (!sessionOwnerById.has(sessionId)) {
        sessionOwnerById.set(sessionId, filePath)
      }
    }
  }
  const candidatesBySession = new Map<string, string[]>()
  for (const [filePath, raw] of rawByPath) {
    const candidates = candidatesBySession.get(raw.sessionId) ?? []
    candidates.push(filePath)
    candidatesBySession.set(raw.sessionId, candidates)
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    if (sessionOwnerById.has(sessionId)) {
      continue
    }
    const canonical = candidates.find((filePath) => sessionIdFromFileName(filePath) === sessionId)
    sessionOwnerById.set(sessionId, canonical ?? candidates[0])
  }

  const parsedByPath = new Map<string, DevinUsagePersistedFile>()
  for (const [filePath, raw] of rawByPath) {
    const owned = !raw.hidden && sessionOwnerById.get(raw.sessionId) === filePath
    const events: DevinUsageAttributedEvent[] = []
    if (owned) {
      for (const event of raw.events) {
        const attributed = await attributeDevinUsageEvent(event, resolveWorktree)
        if (attributed) {
          events.push(attributed)
        }
      }
    }
    parsedByPath.set(filePath, {
      ...raw.file,
      sessionsDb,
      ...devinUsageAggregation.aggregate(events),
      ownedSessionIds: owned ? [raw.sessionId] : [],
      // A hidden session is excluded, not deferred — only a claim lost to a
      // higher-priority file makes this file a reclaim candidate later.
      hasDeferredClaims: !raw.hidden && !owned
    })
  }

  const processedFiles: DevinUsagePersistedFile[] = []
  const sessionsById = new Map<string, DevinUsageSession>()
  const dailyByKey = new Map<string, DevinUsageDailyAggregate>()
  for (const filePath of filePaths) {
    const processed = reusedByPath.get(filePath) ?? parsedByPath.get(filePath)
    if (!processed) {
      continue
    }
    processedFiles.push(processed)
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}
