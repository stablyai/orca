import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  kimiPrimaryAgentWirePath,
  kimiSessionIdFromStatePath,
  kimiSessionIndexPathFromStatePath,
  readKimiWorkDirBySessionId
} from '../ai-vault/session-scanner-kimi-paths'
import { aggregateKimiUsage } from './aggregation'
import {
  attributeKimiUsageEvent,
  getProcessedFileInfo,
  type KimiUsageWorktreeRef
} from './scanner-paths'
import type {
  KimiUsageAttributedEvent,
  KimiUsageParsedEvent,
  KimiUsageProcessedFile,
  KimiUsagePersistedFile
} from './types'

type KimiWireRecord = {
  type?: string
  model?: string
  modelAlias?: string
  usage?: Record<string, unknown>
  usageScope?: string
  time?: number
}

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function timestampToIso(time: unknown): string | null {
  const ms = ensureNumber(time)
  if (ms <= 0) {
    return null
  }
  const millis = ms < 10_000_000_000 ? ms * 1000 : ms
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function buildKimiUsageEventKey(
  sessionId: string,
  timestamp: string,
  inputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number
): string {
  return [
    sessionId,
    timestamp,
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens
  ].join('|')
}

// Parse wire.jsonl for per-turn usage deltas. Skips cumulative 'session'-scoped records.
export async function parseKimiWireForUsage(
  wirePath: string,
  sessionId: string
): Promise<KimiUsageParsedEvent[]> {
  const events: KimiUsageParsedEvent[] = []
  let currentModel: string | null = null
  if (!existsSync(wirePath)) {
    return events
  }
  const stream = createReadStream(wirePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    let record: KimiWireRecord
    try {
      record = JSON.parse(line) as KimiWireRecord
    } catch {
      continue
    }
    if (record.type === 'config.update') {
      currentModel = extractString(record.modelAlias) ?? currentModel
      continue
    }
    if (record.type !== 'usage.record' || record.usageScope === 'session') {
      continue
    }
    const usage = record.usage
    if (!usage || typeof usage !== 'object') {
      continue
    }
    const inputTokens = ensureNumber(usage.inputOther)
    const cachedInputTokens = ensureNumber(usage.inputCacheRead)
    const cacheCreationTokens = ensureNumber(usage.inputCacheCreation)
    const outputTokens = ensureNumber(usage.output)
    const totalTokens = inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
    const timestamp = timestampToIso(record.time)
    if (totalTokens <= 0 || !timestamp) {
      continue
    }
    const model = extractString(record.model) ?? currentModel
    events.push({
      sessionId,
      timestamp,
      eventKey: buildKimiUsageEventKey(
        sessionId,
        timestamp,
        inputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens
      ),
      model,
      cwd: null,
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      totalTokens
    })
  }
  return events
}

async function readKimiStateRecord(statePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function getKimiUsageProcessedFileInfo(
  statePath: string
): Promise<KimiUsageProcessedFile> {
  const stateRecord = await readKimiStateRecord(statePath)
  return getProcessedFileInfo(statePath, kimiPrimaryAgentWirePath(statePath, stateRecord))
}

export async function parseKimiUsageFile(
  statePath: string,
  worktrees: (KimiUsageWorktreeRef & { canonicalPath: string })[],
  options: { claimEventKey?: (eventKey: string) => boolean } = {}
): Promise<KimiUsagePersistedFile> {
  const sessionId = kimiSessionIdFromStatePath(statePath)
  const workDirBySessionId = await readKimiWorkDirBySessionId(
    kimiSessionIndexPathFromStatePath(statePath)
  )
  const cwd = workDirBySessionId.get(sessionId) ?? null
  const stateRecord = await readKimiStateRecord(statePath)
  const wirePath = kimiPrimaryAgentWirePath(statePath, stateRecord)
  const processedFile = await getProcessedFileInfo(statePath, wirePath)
  const rawEvents = await parseKimiWireForUsage(wirePath, sessionId)
  const events: KimiUsageAttributedEvent[] = []
  const ownedEventKeys = new Set<string>()
  let hasDeferredClaims = false
  for (const parsed of rawEvents) {
    if (cwd) {
      parsed.cwd = cwd
    }
    if (options.claimEventKey && !options.claimEventKey(parsed.eventKey)) {
      hasDeferredClaims = true
      continue
    }
    ownedEventKeys.add(parsed.eventKey)
    const attributed = await attributeKimiUsageEvent(parsed, worktrees)
    if (attributed) {
      events.push(attributed)
    }
  }
  return {
    ...processedFile,
    ...aggregateKimiUsage(events),
    ownedEventKeys: [...ownedEventKeys],
    hasDeferredClaims
  }
}
