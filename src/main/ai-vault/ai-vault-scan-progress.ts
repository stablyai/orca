import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import { AiVaultScanTally } from './ai-vault-scan-tally'

// Request signals distinguish scans from index-loop and interactive reads through the same readers.
const reporters = new WeakMap<AbortSignal, { workChanged: () => void; tally: AiVaultScanTally }>()

// Rate-limited because a cold scan lists thousands of folders and files.
export const AI_VAULT_SCAN_PROGRESS_INTERVAL_MS = 1_000

export function trackAiVaultScanProgress(
  signal: AbortSignal,
  report: (work: AiVaultScanWork) => void,
  now: () => number = () => performance.now()
): () => void {
  let lastReportedAt = Number.NEGATIVE_INFINITY
  let trailing: ReturnType<typeof setTimeout> | null = null
  const tally = new AiVaultScanTally()
  const publish = (): void => {
    lastReportedAt = now()
    const snapshot = tally.snapshot()
    try {
      report(snapshot)
    } catch {
      // Reporting cannot interrupt scanning or strand source ownership.
    }
  }
  const workChanged = (): void => {
    if (trailing) {
      return
    }
    const wait = Math.max(0, AI_VAULT_SCAN_PROGRESS_INTERVAL_MS - (now() - lastReportedAt))
    if (wait === 0) {
      publish()
      return
    }
    trailing = setTimeout(() => {
      trailing = null
      publish()
    }, wait)
    trailing.unref?.()
  }
  reporters.set(signal, { tally, workChanged })
  return () => {
    if (trailing) {
      clearTimeout(trailing)
    }
    reporters.delete(signal)
  }
}

function tallyFor(signal: AbortSignal | undefined): AiVaultScanTally | undefined {
  return signal ? reporters.get(signal)?.tally : undefined
}

export function aiVaultScanWork(signal: AbortSignal | undefined): AiVaultScanWork | null {
  return tallyFor(signal)?.snapshot() ?? null
}

/** Source discovery remains open until the returned callback closes it. */
export function openAiVaultScanSource(
  signal: AbortSignal | undefined,
  agent: AiVaultAgent
): () => void {
  const reporter = signal ? reporters.get(signal) : undefined
  if (!reporter) {
    return () => undefined
  }
  const close = reporter.tally.openSource(agent)
  reporter.workChanged()
  return () => {
    close()
    reporter.workChanged()
  }
}

export function noteAiVaultScanFileFound(
  signal: AbortSignal | undefined,
  agent: AiVaultAgent,
  file: { path: string; dev?: number; ino?: number }
): void {
  tallyFor(signal)?.addFile(agent, file)
}

export function noteAiVaultScanDatabases(
  signal: AbortSignal | undefined,
  agent: AiVaultAgent,
  count: number
): void {
  const reporter = signal ? reporters.get(signal) : undefined
  reporter?.tally.addDatabases(agent, count)
  reporter?.workChanged()
}

export function noteAiVaultScanReading(signal: AbortSignal | undefined): void {
  const reporter = signal ? reporters.get(signal) : undefined
  reporter?.tally.startReading()
  reporter?.workChanged()
}

export function aiVaultScanWorkload(signal: AbortSignal | undefined) {
  return tallyFor(signal)?.workload
}

export function noteAiVaultScanWorkChanged(signal: AbortSignal | undefined): void {
  if (signal) {
    reporters.get(signal)?.workChanged()
  }
}
