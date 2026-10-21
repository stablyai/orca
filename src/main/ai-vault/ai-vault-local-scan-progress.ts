import type {
  AiVaultScanProgress,
  AiVaultScanProgressUpdate,
  AiVaultScanWork
} from '../../shared/ai-vault-scan-progress'
import type { AiVaultServiceScanListener } from './session-scanner-service-request-deadline'

type Listener = (update: AiVaultScanProgressUpdate) => void

/** One local scan from coordinator creation through its service reply. */
export type LocalAiVaultScanProgressHandle = AiVaultServiceScanListener & {
  finish: (work: AiVaultScanWork | null) => void
  fail: () => void
}

const MAX_PROGRESS_ENTRIES = 8
const latest = new Map<string, AiVaultScanProgress>()
// Each key's running scan, with the finished entry its failure puts back.
const currentScans = new Map<
  string,
  { handle: LocalAiVaultScanProgressHandle; fallback: AiVaultScanProgress | null }
>()
const listeners = new Set<Listener>()

export function localAiVaultScanProgress(scanKey: string): AiVaultScanProgress | null {
  return latest.get(scanKey) ?? null
}

export function onLocalAiVaultScanProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(scanKey: string, next: AiVaultScanProgress | null): void {
  latest.delete(scanKey)
  if (next) {
    latest.set(scanKey, next)
  }
  while (latest.size > MAX_PROGRESS_ENTRIES) {
    const oldest = latest.keys().next().value
    if (oldest === undefined) {
      break
    }
    latest.delete(oldest)
    for (const listener of listeners) {
      listener({ scanKey: oldest, progress: null })
    }
  }
  for (const listener of listeners) {
    listener({ scanKey, progress: next })
  }
}

/** A replacement takes over its key at once, so a window never sees the key empty mid-refresh. */
export function startLocalAiVaultScanProgress(
  scanKey: string,
  scanId: string,
  now: () => number = Date.now
): LocalAiVaultScanProgressHandle {
  const previous = latest.get(scanKey)
  const fallback =
    previous?.stage === 'finished' ? previous : (currentScans.get(scanKey)?.fallback ?? null)
  let current: AiVaultScanProgress = {
    scanId,
    stage: 'finding',
    agents: [],
    read: { done: 0, total: 0 },
    startedAt: now(),
    settledAt: null
  }
  const handle: LocalAiVaultScanProgressHandle = {
    work: (work) => {
      if (currentScans.get(scanKey)?.handle === handle) {
        current = { ...current, ...work }
        publish(scanKey, current)
      }
    },
    finish: (work) => {
      if (currentScans.get(scanKey)?.handle === handle) {
        currentScans.delete(scanKey)
        publish(scanKey, { ...current, ...work, stage: 'finished', settledAt: now() })
      }
    },
    fail: () => {
      if (currentScans.get(scanKey)?.handle === handle) {
        currentScans.delete(scanKey)
        publish(scanKey, fallback ?? { ...current, settledAt: now() })
      }
    }
  }
  currentScans.set(scanKey, { handle, fallback })
  publish(scanKey, current)
  return handle
}

/** Runs the scanner service request using the coordinator's progress ownership. */
export async function requestLocalAiVaultScan<T extends { work: AiVaultScanWork | null }>(
  request: (listener: AiVaultServiceScanListener) => Promise<T>,
  options: {
    now?: () => number
    progress?: LocalAiVaultScanProgressHandle
    scanKey?: string
    scanId?: string
  } = {}
): Promise<T> {
  const progress =
    options.progress ??
    startLocalAiVaultScanProgress(options.scanKey ?? '', options.scanId ?? '', options.now)
  try {
    const value = await request(progress)
    progress.finish(value.work)
    return value
  } catch (error) {
    progress.fail()
    throw error
  }
}

export function resetLocalAiVaultScanProgressForTests(): void {
  latest.clear()
  currentScans.clear()
  listeners.clear()
}
