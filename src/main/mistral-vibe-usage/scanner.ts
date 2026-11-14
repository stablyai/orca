import { readFile, stat } from 'node:fs/promises'
import { attributeUsageEvent } from '../usage/worktree-attribution/usage-event-attribution'
import { createUsageWorktreeResolver } from '../usage/worktree-attribution/usage-worktree-resolver'
import type { UsageScanWorktreeRef } from '../usage/provider-lifecycle/usage-provider-contract'
import { mistralVibeUsageAggregation } from './aggregation'
import { estimateVibeCostUsd } from './cost-estimate'
import { parseVibeModelPricing, type VibeModelPricing } from './model-pricing'
import { parseVibeSessionIndex } from './session-index-parser'
import { resolveVibeConfigPath, resolveVibeHome, resolveVibeSessionIndexPath } from './vibe-home'
import type {
  MistralVibeUsageAttributedEvent,
  MistralVibeUsageDailyAggregate,
  MistralVibeUsagePersistedFile,
  MistralVibeUsageSession
} from './types'

type FileInfo = { mtimeMs: number; size: number }

async function statFile(path: string): Promise<FileInfo | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

async function readPricing(configPath: string): Promise<Map<string, VibeModelPricing>> {
  const text = await readText(configPath)
  return text === null ? new Map() : parseVibeModelPricing(text)
}

export async function scanMistralVibeUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previousProcessedFiles: MistralVibeUsagePersistedFile[],
  onFilesScanned?: (count: number) => void,
  vibeHome = resolveVibeHome()
): Promise<{
  processedFiles: MistralVibeUsagePersistedFile[]
  sessions: MistralVibeUsageSession[]
  dailyAggregates: MistralVibeUsageDailyAggregate[]
}> {
  const sessionIndexPath = resolveVibeSessionIndexPath(vibeHome)
  const indexInfo = await statFile(sessionIndexPath)
  if (!indexInfo) {
    return { processedFiles: [], sessions: [], dailyAggregates: [] }
  }
  const configPath = resolveVibeConfigPath(vibeHome)
  const pricingMtimeMs = (await statFile(configPath))?.mtimeMs ?? null
  const previous = previousProcessedFiles.find((file) => file.path === sessionIndexPath)
  if (
    previous &&
    previous.mtimeMs === indexInfo.mtimeMs &&
    previous.size === indexInfo.size &&
    previous.pricingMtimeMs === pricingMtimeMs
  ) {
    return {
      processedFiles: [previous],
      sessions: previous.sessions,
      dailyAggregates: previous.dailyAggregates
    }
  }

  const text = await readText(sessionIndexPath)
  if (text === null) {
    return { processedFiles: [], sessions: [], dailyAggregates: [] }
  }
  const pricing = await readPricing(configPath)
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const events: MistralVibeUsageAttributedEvent[] = []
  for (const parsed of parseVibeSessionIndex(text)) {
    const estimatedCostUsd = estimateVibeCostUsd(parsed.model, parsed, pricing)
    const attributed = attributeUsageEvent(
      { ...parsed, estimatedCostUsd, hasUnpricedModels: estimatedCostUsd === null },
      resolveWorktree
    )
    if (attributed) {
      events.push(attributed)
    }
  }
  onFilesScanned?.(1)

  const processed: MistralVibeUsagePersistedFile = {
    path: sessionIndexPath,
    mtimeMs: indexInfo.mtimeMs,
    size: indexInfo.size,
    pricingMtimeMs,
    ...mistralVibeUsageAggregation.aggregate(events)
  }
  return {
    processedFiles: [processed],
    sessions: processed.sessions,
    dailyAggregates: processed.dailyAggregates
  }
}
