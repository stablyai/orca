import type { OrcaRuntimeService } from '../orca-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'

export const AUTOMATIC_WORKER_TERMINAL_RELEASE_DELAY_MS = 30_000

const pendingByRuntime = new WeakMap<OrcaRuntimeService, Map<string, NodeJS.Timeout>>()

// The grace window preserves exact terminal reuse after worker_done. Explicit retain, user
// takeover, ownership transfer, and identity checks all remain authoritative when it expires.
export function scheduleAutomaticWorkerTerminalRelease(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  delayMs = AUTOMATIC_WORKER_TERMINAL_RELEASE_DELAY_MS
): void {
  let pending = pendingByRuntime.get(runtime)
  if (!pending) {
    pending = new Map()
    pendingByRuntime.set(runtime, pending)
  }
  if (pending.has(dispatchId)) {
    return
  }
  const timer = setTimeout(
    () => {
      pending?.delete(dispatchId)
      requestAutomaticReleaseNow(runtime, dispatchId)
    },
    Math.max(0, delayMs)
  )
  timer.unref()
  pending.set(dispatchId, timer)
}

// Rebuilds timers after startup/reconnect from settled, still-owned resources. SQLite timestamps
// are UTC; invalid legacy timestamps receive a fresh grace window instead of an eager close.
export function scheduleAutomaticWorkerTerminalReleaseCandidates(
  runtime: OrcaRuntimeService
): void {
  const now = Date.now()
  for (const candidate of runtime
    .getOrchestrationDb()
    .listAutomaticWorkerTerminalReleaseCandidates()) {
    const settledAt = parseSqliteTimestamp(candidate.settledAt)
    const elapsed = settledAt === null ? 0 : Math.max(0, now - settledAt)
    scheduleAutomaticWorkerTerminalRelease(
      runtime,
      candidate.dispatchId,
      Math.max(0, AUTOMATIC_WORKER_TERMINAL_RELEASE_DELAY_MS - elapsed)
    )
  }
}

function requestAutomaticReleaseNow(runtime: OrcaRuntimeService, dispatchId: string): void {
  let requested
  try {
    requested = runtime
      .getOrchestrationDb()
      .requestWorkerTerminalRelease(dispatchId, { preserveExplicitRetain: true })
  } catch (error) {
    // Completion is authoritative; cleanup failure must not turn a settled report into an error.
    console.warn('[orchestration] automatic worker terminal release request failed', {
      dispatchId,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (requested.disposition !== 'requested') {
    return
  }
  void reconcileRequestedWorkerTerminalReleases(runtime).catch((error) => {
    // Intent is durable. Startup/reconnect discovery will retry without broadening the close.
    console.warn('[orchestration] automatic worker terminal release failed', {
      dispatchId,
      error: error instanceof Error ? error.message : String(error)
    })
  })
}

function parseSqliteTimestamp(value: string): number | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}
