import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'

export type DurableHistoryReadScope = { valid: boolean; readers: number }

type Entry = { snapshot: TerminalSnapshot; bytes: number }

export function sameHistoryIdentity(a: TerminalSnapshot, b: TerminalSnapshot): boolean {
  return (
    a.sessionIncarnationId !== undefined &&
    a.sessionIncarnationId === b.sessionIncarnationId &&
    a.historyRevision !== undefined &&
    a.historyRevision === b.historyRevision &&
    a.outputSequence === b.outputSequence &&
    a.cols === b.cols &&
    a.rows === b.rows
  )
}

/** Adapter-wide LRU; charge UTF-16 backing storage and link payloads, not just row counts. */
export class SettledDurableHistory {
  private entries = new Map<string, Entry>()
  private scopes = new Map<string, DurableHistoryReadScope>()
  private bytes = 0

  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

  begin(id: string): DurableHistoryReadScope {
    let scope = this.scopes.get(id)
    if (!scope) {
      scope = { valid: true, readers: 0 }
      this.scopes.set(id, scope)
    }
    scope.readers++
    return scope
  }

  end(id: string, scope: DurableHistoryReadScope): void {
    scope.readers--
    if (scope.readers === 0 && this.scopes.get(id) === scope) {
      this.scopes.delete(id)
    }
  }

  get(id: string, live: TerminalSnapshot): TerminalSnapshot | undefined {
    const entry = this.entries.get(id)
    if (!entry) {
      return undefined
    }
    if (!sameHistoryIdentity(entry.snapshot, live)) {
      this.dropEntry(id)
      return undefined
    }
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.snapshot
  }

  retain(id: string, snapshot: TerminalSnapshot, scope: DurableHistoryReadScope): void {
    if (!scope.valid || !sameHistoryIdentity(snapshot, snapshot)) {
      return
    }
    this.dropEntry(id)
    const strings = [
      snapshot.snapshotAnsi,
      snapshot.scrollbackAnsi,
      snapshot.rehydrateSequences,
      snapshot.frameRestoreAnsi ?? '',
      snapshot.pendingEscapeTailAnsi ?? '',
      snapshot.cwd ?? '',
      snapshot.lastTitle ?? '',
      snapshot.sessionIncarnationId ?? ''
    ]
    const bytes =
      strings.reduce((sum, value) => sum + value.length * 2, 0) +
      (snapshot.oscLinks?.reduce((sum, link) => sum + link.uri.length * 2 + 24, 0) ?? 0)
    if (bytes > this.maxBytes) {
      return
    }
    this.entries.set(id, { snapshot, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > 16) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.dropEntry(oldest)
    }
  }

  forgetSnapshot(id: string): void {
    this.dropEntry(id)
  }

  delete(id: string): void {
    this.forgetSnapshot(id)
    const scope = this.scopes.get(id)
    if (scope) {
      scope.valid = false
    }
    this.scopes.delete(id)
  }

  clear(): void {
    for (const scope of this.scopes.values()) {
      scope.valid = false
    }
    this.scopes.clear()
    this.entries.clear()
    this.bytes = 0
  }

  private dropEntry(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      this.bytes -= entry.bytes
    }
    this.entries.delete(id)
  }
}
