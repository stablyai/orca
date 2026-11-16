import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  estimateAntigravityUsageUsd,
  readAntigravityTranscriptUsage
} from '../../../../src/shared/agent-usage/analytics/antigravity-transcript-usage.ts'
import { antigravityPublishedPrices } from '../../../../src/shared/agent-usage/analytics/antigravity-published-prices.ts'

const MAX_FILES = 1000
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
const { values } = parseArgs({
  options: {
    brain: { type: 'string', multiple: true },
    prices: { type: 'string' },
    help: { type: 'boolean' }
  }
})

if (values.help) {
  console.log(
    'node antigravity-usage-report.mjs [--brain /path/to/brain ...] [--prices prices.json]'
  )
  process.exit(0)
}

const home = homedir()
const configHome =
  process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
const roots = values.brain ?? [
  join(home, '.gemini', 'antigravity-cli', 'brain'),
  join(configHome, 'orca', 'antigravity-chat', 'antigravity-acp', 'brain')
]
const prices = values.prices ? JSON.parse(await readFile(values.prices, 'utf8')) : {}
if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
  throw new Error('Prices must be an object keyed by exact transcript model ID')
}
const seenSessions = new Set()
const models = new Map()
const coverage = {
  discoveredSessions: 0,
  scannedSessions: 0,
  sessionsWithUsage: 0,
  measuredSteps: 0,
  unpricedSteps: 0,
  malformedLines: 0,
  oversizedLines: 0,
  skippedSessions: 0,
  unavailableRoots: 0
}

for (const root of roots) {
  let entries
  try {
    entries = await readdir(resolve(root), { withFileTypes: true })
  } catch {
    coverage.unavailableRoots++
    continue
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }
    const logs = join(resolve(root), entry.name, '.system_generated', 'logs')
    let candidate = null
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      try {
        const path = join(logs, name)
        const info = await stat(path)
        if (info.isFile()) {
          candidate = { path, size: info.size, session: await realpath(join(logs, '..', '..')) }
          break
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
          throw error
        }
      }
    }
    if (!candidate || seenSessions.has(candidate.session)) {
      continue
    }
    seenSessions.add(candidate.session)
    coverage.discoveredSessions++
    if (coverage.scannedSessions >= MAX_FILES || candidate.size > MAX_FILE_BYTES) {
      coverage.skippedSessions++
      continue
    }
    const chunks = []
    for await (const chunk of createReadStream(candidate.path, { end: MAX_FILE_BYTES })) {
      chunks.push(chunk)
    }
    const content = Buffer.concat(chunks)
    if (content.length > MAX_FILE_BYTES) {
      coverage.skippedSessions++
      continue
    }
    const steps = new Map()
    for (const line of content.toString('utf8').split('\n')) {
      if (!line.trim()) {
        continue
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        coverage.oversizedLines++
        continue
      }
      let record
      try {
        record = JSON.parse(line)
      } catch {
        coverage.malformedLines++
        continue
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        continue
      }
      const usage = readAntigravityTranscriptUsage(record)
      if (usage) {
        steps.set(usage.step, usage)
      }
    }
    coverage.scannedSessions++
    if (steps.size) {
      coverage.sessionsWithUsage++
    }
    for (const usage of steps.values()) {
      coverage.measuredSteps++
      const cost = estimateAntigravityUsageUsd(
        usage,
        usage.model && Object.hasOwn(prices, usage.model)
          ? prices[usage.model]
          : antigravityPublishedPrices(usage.model, usage.createdAt)
      )
      if (cost === null) {
        coverage.unpricedSteps++
      }
      const key = usage.model
      const row = models.get(key) ?? {
        model: key,
        steps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        unpricedSteps: 0,
        pricedSubtotalUsd: 0
      }
      row.steps++
      row.inputTokens += usage.inputTokens
      row.cacheReadTokens += usage.cacheReadTokens
      row.outputTokens += usage.outputTokens
      row.totalTokens += usage.totalTokens
      row.unpricedSteps += cost === null ? 1 : 0
      row.pricedSubtotalUsd += cost ?? 0
      models.set(key, row)
    }
  }
}

const rows = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens)
const pricedSubtotalUsd = rows.reduce((sum, row) => sum + row.pricedSubtotalUsd, 0)
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      costBasis:
        'Google Standard text API reference prices, optionally overridden; not an Antigravity bill',
      publishedPriceSource: 'https://aistudio.google.com/docs/pricing',
      publishedPricesVerifiedAt: '2026-11-16',
      coverage,
      limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxLineBytes: MAX_LINE_BYTES },
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      pricedSubtotalUsd,
      measuredUsageEstimateUsd:
        coverage.measuredSteps > 0 && coverage.unpricedSteps === 0 ? pricedSubtotalUsd : null,
      models: rows.map((row) => ({
        ...row,
        estimatedUsd: row.unpricedSteps === 0 ? row.pricedSubtotalUsd : null
      }))
    },
    null,
    2
  )
)
