import type {
  CodexPaneAccountRecord,
  CodexPaneAccountRegistryFile
} from './codex-pane-account-registry-types'

// Why: bounds both crash-leaked disk records and mutations retained while the file is unavailable.
const MAX_TRACKED_PANES = 2000
const RETRY_DELAYS_MS = [100, 1_000, 5_000, 30_000] as const

type MutationStoreDependencies = {
  read: () => CodexPaneAccountRegistryFile | null
  write: (registry: CodexPaneAccountRegistryFile) => boolean
}

export class CodexPaneAccountRegistryMutations {
  private readonly pending = new Map<string, CodexPaneAccountRecord | null>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private needsPersistence = false

  constructor(private readonly dependencies: MutationStoreDependencies) {}

  record(ptyId: string, record: CodexPaneAccountRecord | null): void {
    this.pending.delete(ptyId)
    this.pending.set(ptyId, record)
    if (this.pending.size > MAX_TRACKED_PANES) {
      const oldestPtyId = this.pending.keys().next().value
      if (typeof oldestPtyId === 'string') {
        this.pending.delete(oldestPtyId)
        console.warn('[codex-pane-accounts] Dropped oldest pending registry mutation at capacity')
      }
    }
    this.flush()
  }

  flush(): void {
    if (this.pending.size === 0 && !this.needsPersistence) {
      this.clearRetryState()
      return
    }
    const registry = this.dependencies.read()
    if (!registry) {
      this.scheduleRetry()
      return
    }
    let changed = false
    for (const [ptyId, record] of this.pending) {
      changed = applyMutation(registry, ptyId, record) || changed
    }
    trimRegistry(registry)
    if ((changed || this.needsPersistence) && !this.dependencies.write(registry)) {
      this.needsPersistence = true
      this.scheduleRetry()
      return
    }
    this.needsPersistence = false
    this.pending.clear()
    this.clearRetryState()
  }

  getPendingRegistry(): CodexPaneAccountRegistryFile | null {
    if (this.pending.size === 0) {
      return null
    }
    const registry: CodexPaneAccountRegistryFile = { version: 2, panes: {} }
    for (const [ptyId, record] of this.pending) {
      applyMutation(registry, ptyId, record)
    }
    return registry
  }

  persistReconciliation(registry: CodexPaneAccountRegistryFile, changed: boolean): void {
    if (!changed) {
      return
    }
    if (!this.dependencies.write(registry)) {
      this.needsPersistence = true
      this.scheduleRetry()
      return
    }
    this.needsPersistence = false
    this.pending.clear()
    this.clearRetryState()
  }

  reset(): void {
    this.needsPersistence = false
    this.pending.clear()
    this.clearRetryState()
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retryAttempt >= RETRY_DELAYS_MS.length) {
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.flush()
    }, RETRY_DELAYS_MS[this.retryAttempt])
    this.retryAttempt += 1
    this.retryTimer.unref?.()
  }

  private clearRetryState(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryAttempt = 0
  }
}

function applyMutation(
  registry: CodexPaneAccountRegistryFile,
  ptyId: string,
  record: CodexPaneAccountRecord | null
): boolean {
  if (!record) {
    if (!(ptyId in registry.panes)) {
      return false
    }
    delete registry.panes[ptyId]
    return true
  }
  const existing = registry.panes[ptyId]
  if (recordsEqual(existing, record)) {
    return false
  }
  registry.panes[ptyId] = record
  return true
}

function recordsEqual(
  left: CodexPaneAccountRecord | undefined,
  right: CodexPaneAccountRecord
): boolean {
  return (
    left?.selectionKey === right.selectionKey &&
    left.accountId === right.accountId &&
    left.homeRoute === right.homeRoute &&
    left.shellStartupHomeOverride?.home === right.shellStartupHomeOverride?.home &&
    left.shellStartupHomeOverride?.shell === right.shellStartupHomeOverride?.shell &&
    left.shellStartupHomeOverride?.configHome === right.shellStartupHomeOverride?.configHome &&
    left.shellStartupHomeOverride?.codexHome === right.shellStartupHomeOverride?.codexHome &&
    left.environmentHomeOverride?.codexHome === right.environmentHomeOverride?.codexHome
  )
}

function trimRegistry(registry: CodexPaneAccountRegistryFile): void {
  const trackedPtyIds = Object.keys(registry.panes)
  if (trackedPtyIds.length <= MAX_TRACKED_PANES) {
    return
  }
  for (const staleId of trackedPtyIds.slice(0, trackedPtyIds.length - MAX_TRACKED_PANES)) {
    delete registry.panes[staleId]
  }
}
