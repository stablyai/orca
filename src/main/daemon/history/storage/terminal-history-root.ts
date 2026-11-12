import { resolve } from 'node:path'
import {
  TerminalHistoryWriterHandoff,
  type HistoryWriterAdmission
} from './terminal-history-writer-handoff'

const roots = new Map<string, TerminalHistoryRoot>()

/**
 * Process-local exclusion for one host-local history path. Cross-process exclusion stays with the
 * profile lock and newer-daemon hold; this only orders managers and bindings inside this process.
 */
export class TerminalHistoryRoot {
  private participants = 0
  private readonly writers = new TerminalHistoryWriterHandoff(() => this.releaseIfIdle())

  constructor(readonly path: string) {}

  /** Participation lasts until the participant's actual retirement, not its routing. */
  registerHost(): () => void {
    this.participants += 1
    let registered = true
    return () => {
      if (!registered) {
        return
      }
      registered = false
      this.participants -= 1
      this.releaseIfIdle()
    }
  }

  admitWriter(
    id: string,
    owner: object,
    retire: () => Promise<void> | undefined
  ): HistoryWriterAdmission {
    return this.registered().writers.admitWriter(id, owner, retire)
  }

  admitUnclaimedWriter(
    id: string,
    owner: object,
    retire: () => Promise<void> | undefined
  ): HistoryWriterAdmission | undefined {
    return this.registered().writers.admitWriter(id, owner, retire, { ifUnclaimed: true })
  }

  // A released root is never reused; claims always land on the registered one.
  private registered(): TerminalHistoryRoot {
    return roots.get(this.path) === this ? this : terminalHistoryRoot(this.path)
  }

  private releaseIfIdle(): void {
    if (this.participants === 0 && this.writers.idle && roots.get(this.path) === this) {
      roots.delete(this.path)
    }
  }
}

export function terminalHistoryRoot(path: string): TerminalHistoryRoot {
  const key = resolve(path)
  let root = roots.get(key)
  if (!root) {
    root = new TerminalHistoryRoot(key)
    roots.set(key, root)
  }
  return root
}
