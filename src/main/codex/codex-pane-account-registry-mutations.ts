import { PersistRetryBackoff } from '../persist-retry-backoff'
import type {
  CodexPaneAccountRecord,
  CodexPaneAccountRegistryFile
} from './codex-pane-account-registry-types'

// Why: bounds both crash-leaked disk records and mutations retained while the file is unavailable.
const MAX_TRACKED_PANES = 2000

type MutationStoreDependencies = {
  read: () => CodexPaneAccountRegistryFile | null
  write: (registry: CodexPaneAccountRegistryFile) => boolean
}

export class CodexPaneAccountRegistryMutations {
  private readonly pending = new Map<string, CodexPaneAccountRecord | null>()
  private readonly retry = new PersistRetryBackoff(() => this.flush())
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
      this.retry.clear()
      return
    }
    const registry = this.dependencies.read()
    if (!registry) {
      this.retry.schedule()
      return
    }
    let changed = false
    for (const [ptyId, record] of this.pending) {
      changed = applyMutation(registry, ptyId, record) || changed
    }
    trimRegistry(registry)
    if ((changed || this.needsPersistence) && !this.dependencies.write(registry)) {
      this.needsPersistence = true
      this.retry.schedule()
      return
    }
    this.needsPersistence = false
    this.pending.clear()
    this.retry.clear()
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
      this.retry.schedule()
      return
    }
    this.needsPersistence = false
    this.pending.clear()
    this.retry.clear()
  }

  reset(): void {
    this.needsPersistence = false
    this.pending.clear()
    this.retry.clear()
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
    left.kept === right.kept
  )
}

function trimRegistry(registry: CodexPaneAccountRegistryFile): void {
  // Why: kept panes are a person's explicit choice and never age out; the cap
  // still bounds the records nobody chose to keep.
  const trimmablePtyIds = Object.keys(registry.panes).filter((id) => !registry.panes[id]?.kept)
  if (trimmablePtyIds.length <= MAX_TRACKED_PANES) {
    return
  }
  for (const staleId of trimmablePtyIds.slice(0, trimmablePtyIds.length - MAX_TRACKED_PANES)) {
    delete registry.panes[staleId]
  }
}
