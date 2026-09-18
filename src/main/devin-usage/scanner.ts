import { discoverFiles } from '../ai-vault/session-scanner-discovery'
import { DEVIN_TRANSCRIPTS_DIR } from '../ai-vault/session-scanner-agent-sources'
import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { attributeDevinUsageEvent } from './devin-usage-event-attribution'
import { devinUsageAggregation } from './devin-usage-aggregation'
import { parseDevinUsageFile } from './devin-usage-record-parser'
import type { DevinUsageDailyAggregate, DevinUsagePersistedFile, DevinUsageSession } from './types'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import { yieldToEventLoop } from '../../shared/event-loop-yield'

export async function scanDevinUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previous: DevinUsagePersistedFile[] = [],
  onFilesScanned?: (count: number) => void
): Promise<{
  processedFiles: DevinUsagePersistedFile[]
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
}> {
  const discovery = await discoverFiles({
    rootDir: DEVIN_TRANSCRIPTS_DIR,
    limit: Number.MAX_SAFE_INTEGER,
    agent: 'devin',
    issues: [],
    extensions: ['.json']
  })
  const previousByPath = new Map(previous.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)
  const processedFiles: DevinUsagePersistedFile[] = []

  for (const [index, file] of discovery.files.entries()) {
    const cached = previousByPath.get(file.path)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.sizeBytes) {
      processedFiles.push(cached)
      onFilesScanned?.(1)
      continue
    }
    let aggregate: { sessions: DevinUsageSession[]; dailyAggregates: DevinUsageDailyAggregate[] }
    try {
      const events = (await parseDevinUsageFile(file.path))
        .map((event) => attributeDevinUsageEvent(event, resolveWorktree))
        .filter((event) => event !== null)
      aggregate = devinUsageAggregation.aggregate(events)
    } catch (error) {
      // Why: skip corrupt transcripts without caching them so a later scan retries once the file is rewritten.
      console.warn(
        `[devin-usage] skipping unreadable transcript: ${error instanceof Error ? error.message : String(error)}`
      )
      onFilesScanned?.(1)
      continue
    }
    processedFiles.push({
      path: file.path,
      mtimeMs: file.mtimeMs,
      size: file.sizeBytes ?? 0,
      sessions: aggregate.sessions,
      dailyAggregates: aggregate.dailyAggregates
    })
    onFilesScanned?.(1)
    if ((index + 1) % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  const sessionsById = new Map<string, DevinUsageSession>()
  const dailyByKey = new Map<string, DevinUsageDailyAggregate>()
  for (const file of processedFiles) {
    devinUsageAggregation.mergeSessions(sessionsById, file.sessions)
    devinUsageAggregation.mergeDailyAggregates(dailyByKey, file.dailyAggregates)
  }
  return {
    processedFiles,
    sessions: devinUsageAggregation.finalizeSessions(sessionsById),
    dailyAggregates: devinUsageAggregation.sortDailyAggregates(dailyByKey)
  }
}
