import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  LocalUsageHistoryHourlyPoint,
  LocalUsageHistoryProvider
} from '../../shared/local-usage-history-types'
import type {
  LocalUsageHistoryPersistedFile,
  LocalUsageHistoryScanResult,
  LocalUsageHistorySource
} from './types'

type TokenUsageEvent = Omit<LocalUsageHistoryHourlyPoint, 'day' | 'hour'> & {
  timestampMs: number
}

const YIELD_EVERY_FILES = 10

export function getLocalUsageHistorySource(
  provider: LocalUsageHistoryProvider
): LocalUsageHistorySource {
  if (provider === 'kimi') {
    const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
    return { provider, rootDir: join(kimiHome, 'sessions') }
  }
  return { provider, rootDir: join(homedir(), '.gemini', 'tmp') }
}

export async function scanLocalUsageHistory(args: {
  provider: LocalUsageHistoryProvider
  rootDir: string
  previousFiles: readonly LocalUsageHistoryPersistedFile[]
}): Promise<LocalUsageHistoryScanResult> {
  const filePaths = await listUsageHistoryFiles(args.provider, args.rootDir)
  const previousByPath = new Map(args.previousFiles.map((file) => [file.path, file]))
  const processedFiles: LocalUsageHistoryPersistedFile[] = []

  for (const [index, path] of filePaths.entries()) {
    const metadata = await stat(path)
    const previous = previousByPath.get(path)
    if (previous && previous.mtimeMs === metadata.mtimeMs && previous.size === metadata.size) {
      processedFiles.push(previous)
    } else {
      processedFiles.push({
        path,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        hourlyAggregates: await parseUsageHistoryFile(args.provider, path)
      })
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    processedFiles,
    hourlyAggregates: combineHourlyAggregates(
      processedFiles.flatMap((file) => file.hourlyAggregates)
    )
  }
}

async function listUsageHistoryFiles(
  provider: LocalUsageHistoryProvider,
  rootDir: string
): Promise<string[]> {
  try {
    return await walkUsageHistoryFiles(provider, rootDir)
  } catch {
    // Missing local history is a normal first-run condition.
    return []
  }
}

async function walkUsageHistoryFiles(
  provider: LocalUsageHistoryProvider,
  directory: string
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkUsageHistoryFiles(provider, path)))
    } else if (entry.isFile() && isUsageHistoryFile(provider, path)) {
      files.push(path)
    }
  }
  return files.sort()
}

function isUsageHistoryFile(provider: LocalUsageHistoryProvider, path: string): boolean {
  if (provider === 'kimi') {
    return basename(path) === 'wire.jsonl'
  }
  return path.endsWith('.json') || path.endsWith('.jsonl')
}

async function parseUsageHistoryFile(
  provider: LocalUsageHistoryProvider,
  path: string
): Promise<LocalUsageHistoryHourlyPoint[]> {
  try {
    const events = path.endsWith('.jsonl')
      ? await parseJsonlEvents(provider, path)
      : parseJsonDocumentEvents(provider, await readFile(path, 'utf-8'))
    return aggregateEvents(events)
  } catch {
    // History files can be atomically replaced while a CLI is running. Treat a
    // mid-write read as empty and retry when its mtime changes on the next scan.
    return []
  }
}

async function parseJsonlEvents(
  provider: LocalUsageHistoryProvider,
  path: string
): Promise<TokenUsageEvent[]> {
  const events: TokenUsageEvent[] = []
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    const record = parseRecord(line)
    const event = record ? parseUsageEvent(provider, record) : null
    if (event) {
      events.push(event)
    }
  }
  return events
}

function parseJsonDocumentEvents(
  provider: LocalUsageHistoryProvider,
  content: string
): TokenUsageEvent[] {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return []
  }
  const messages = Array.isArray(record.messages) ? record.messages : [record]
  return messages.flatMap((message) => {
    const event = parseUsageEvent(provider, asRecord(message))
    return event ? [event] : []
  })
}

function parseUsageEvent(
  provider: LocalUsageHistoryProvider,
  record: Record<string, unknown> | null
): TokenUsageEvent | null {
  if (!record) {
    return null
  }
  return provider === 'gemini' ? parseGeminiUsageEvent(record) : parseKimiUsageEvent(record)
}

function parseGeminiUsageEvent(record: Record<string, unknown>): TokenUsageEvent | null {
  if (record.type !== 'gemini') {
    return null
  }
  const timestampMs = parseTimestamp(record.timestamp)
  const usage = asRecord(record.tokens)
  if (!Number.isFinite(timestampMs) || !usage) {
    return null
  }
  const inputTokens = asNumber(usage.input)
  const cachedInputTokens = asNumber(usage.cached)
  const outputTokens = asNumber(usage.output)
  const reasoningOutputTokens = asNumber(usage.thoughts)
  const toolTokens = asNumber(usage.tool)
  const reportedTotal = asNumber(usage.total)
  const totalTokens =
    reportedTotal > 0
      ? reportedTotal
      : inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens + toolTokens
  return totalTokens > 0
    ? {
        timestampMs,
        eventCount: 1,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        cacheWriteTokens: 0,
        toolTokens,
        totalTokens
      }
    : null
}

function parseKimiUsageEvent(record: Record<string, unknown>): TokenUsageEvent | null {
  if (record.type !== 'usage.record' || record.usageScope === 'session') {
    return null
  }
  const timestampMs = parseTimestamp(record.time)
  const usage = asRecord(record.usage)
  if (!Number.isFinite(timestampMs) || !usage) {
    return null
  }
  const inputTokens = asNumber(usage.inputOther)
  const cachedInputTokens = asNumber(usage.inputCacheRead)
  const outputTokens = asNumber(usage.output)
  const cacheWriteTokens = asNumber(usage.inputCacheCreation)
  const totalTokens = inputTokens + cachedInputTokens + outputTokens + cacheWriteTokens
  return totalTokens > 0
    ? {
        timestampMs,
        eventCount: 1,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens: 0,
        cacheWriteTokens,
        toolTokens: 0,
        totalTokens
      }
    : null
}

function aggregateEvents(events: readonly TokenUsageEvent[]): LocalUsageHistoryHourlyPoint[] {
  const aggregates = new Map<string, LocalUsageHistoryHourlyPoint>()
  for (const event of events) {
    const date = new Date(event.timestampMs)
    const day = formatLocalDay(date)
    const hour = date.getHours()
    const key = `${day}::${hour}`
    const aggregate =
      aggregates.get(key) ??
      ({
        day,
        hour,
        eventCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        cacheWriteTokens: 0,
        toolTokens: 0,
        totalTokens: 0
      } satisfies LocalUsageHistoryHourlyPoint)
    aggregate.eventCount += event.eventCount
    aggregate.inputTokens += event.inputTokens
    aggregate.cachedInputTokens += event.cachedInputTokens
    aggregate.outputTokens += event.outputTokens
    aggregate.reasoningOutputTokens += event.reasoningOutputTokens
    aggregate.cacheWriteTokens += event.cacheWriteTokens
    aggregate.toolTokens += event.toolTokens
    aggregate.totalTokens += event.totalTokens
    aggregates.set(key, aggregate)
  }
  return [...aggregates.values()].sort(compareHourlyPoints)
}

function combineHourlyAggregates(
  points: readonly LocalUsageHistoryHourlyPoint[]
): LocalUsageHistoryHourlyPoint[] {
  const syntheticEvents = points.map((point) => ({
    ...point,
    timestampMs: new Date(`${point.day}T${String(point.hour).padStart(2, '0')}:00:00`).getTime()
  }))
  return aggregateEvents(syntheticEvents)
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line) as unknown)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'string') {
    return Date.parse(value)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  return value > 1_000_000_000_000 ? value : value * 1000
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function compareHourlyPoints(
  left: LocalUsageHistoryHourlyPoint,
  right: LocalUsageHistoryHourlyPoint
): number {
  return left.day.localeCompare(right.day) || left.hour - right.hour
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
