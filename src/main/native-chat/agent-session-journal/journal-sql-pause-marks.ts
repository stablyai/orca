import type { JournalQueuePauseMarks } from './queued-message-pause'
import { createJournalQueuePauseMarks } from './queued-message-pause'
import { JournalEncodedScalar } from './journal-outcome-scalars'
import { JournalSqlScalars } from './journal-sql-scalars'
import type { JournalSqlScope } from './journal-sql-scope'

type Clear = NonNullable<JournalQueuePauseMarks['cleared']>
type Header = Omit<JournalQueuePauseMarks, 'cleared'> & {
  cleared?: Omit<Clear, 'messageIds'> & { messageIds: null }
}
const identities = new WeakMap<object, string>()

export function journalSqlPauseKey(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (identities.get(value) ?? value) : value
}

export function journalSqlPauseSchema(): string {
  return `CREATE TABLE IF NOT EXISTS journal_proj_clear_members (
    session_id TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL,
    message_id TEXT NOT NULL, PRIMARY KEY (session_id, generation, ordinal)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS journal_proj_clear_members_id
    ON journal_proj_clear_members(session_id, generation, message_id);`
}

/** Only changing marks loads clear membership; unchanged commands reuse the encoded saved scalar. */
export class JournalSqlPauseMarks {
  private readonly scalars: JournalSqlScalars
  private readonly wrapped = new WeakMap<object, object>()
  private dirty = false
  private membersChanged = false
  private stopVersion: number
  private clearVersion: number
  private encoded: JournalEncodedScalar
  private marks: JournalQueuePauseMarks

  constructor(private readonly scope: JournalSqlScope) {
    this.scalars = new JournalSqlScalars(scope, 'pause-marks')
    this.stopVersion = this.scalars.get('stopVersion', 0)
    this.clearVersion = this.scalars.get('clearVersion', 0)
    const header = this.scalars.get<Header>('header', {
      latestStop: null,
      resumedSequence: 0,
      reopenedSequence: 0
    })
    this.encoded = new JournalEncodedScalar(
      () =>
        this.scalars.get<string | null>('encoded', null) ??
        JSON.stringify(createJournalQueuePauseMarks())
    )
    let members: readonly string[] | undefined
    const readMembers = () => (members ??= this.readMembers())
    const writeMembers = (next: readonly string[]) => {
      members = next
      this.membersChanged = true
      this.dirty = true
    }
    const clear: Clear | undefined = header.cleared && {
      ...header.cleared,
      get messageIds() {
        return readMembers()
      },
      set messageIds(next: readonly string[]) {
        writeMembers(next)
      }
    }
    this.marks = this.wrap({ ...header, cleared: clear })
    this.identify()
  }

  get value(): JournalQueuePauseMarks {
    return this.marks
  }

  replace(value: JournalQueuePauseMarks): void {
    this.stopVersion++
    this.clearVersion++
    this.marks = this.wrap(value)
    this.dirty = true
    this.membersChanged = true
    this.identify()
  }

  snapshot(): JournalEncodedScalar {
    this.flush()
    return this.encoded
  }

  flush(): void {
    if (!this.dirty) {
      return
    }
    // Freeze the previous lazy snapshot before replacing its database row.
    void this.encoded.json
    const marks = this.marks
    const stop = marks.latestStop
    const clear = marks.cleared
    if (this.membersChanged) {
      this.scope.db
        .prepare('DELETE FROM journal_proj_clear_members WHERE session_id=? AND generation=?')
        .run(...this.scope.prefix)
      const insert = this.scope.db.prepare(`INSERT INTO journal_proj_clear_members
        (session_id, generation, ordinal, message_id) VALUES (?, ?, ?, ?)`)
      for (const [ordinal, id] of (clear?.messageIds ?? []).entries()) {
        insert.run(...this.scope.prefix, ordinal, id)
      }
    }
    const header: Header = {
      ...marks,
      cleared: clear ? { ...clear, messageIds: null } : undefined
    }
    // Keep the existing scalar's property order, including a clear appended after the initial marks.
    this.encoded = new JournalEncodedScalar(
      JSON.stringify({
        ...marks,
        latestStop: stop && { sequence: stop.sequence, event: stop.event }
      })
    )
    this.scalars.set('header', header)
    this.scalars.set('encoded', this.encoded.json)
    this.scalars.set('stopVersion', this.stopVersion)
    this.scalars.set('clearVersion', this.clearVersion)
    this.dirty = false
    this.membersChanged = false
  }

  private identify(): void {
    if (this.marks.latestStop) {
      identities.set(this.marks.latestStop, `stop:${this.stopVersion}`)
    }
    if (this.marks.cleared) {
      identities.set(this.marks.cleared, `clear:${this.clearVersion}`)
    }
  }

  private readMembers(): readonly string[] {
    return this.scope.db
      .prepare(`SELECT message_id FROM journal_proj_clear_members
      WHERE session_id=? AND generation=? ORDER BY ordinal`)
      .all(...this.scope.prefix)
      .map((row) => String(this.scope.examined(row).message_id))
  }

  private wrap<T extends object>(value: T): T {
    const previous = this.wrapped.get(value)
    if (previous) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each wrapper keeps the original object's properties and type.
      return previous as T
    }
    const proxy = new Proxy(value, {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy getter preserves the lazy clear-members accessor and native array methods.
      get: (target, key, receiver) => {
        const child = Reflect.get(target, key, receiver)
        return typeof child === 'object' && child !== null ? this.wrap(child) : child
      },
      set: (target, key, next) => {
        const previous = Object.getOwnPropertyDescriptor(target, key)?.value
        const unchanged =
          previous === next ||
          (typeof previous === 'object' && previous !== null && this.wrapped.get(previous) === next)
        if (!unchanged) {
          Reflect.set(target, key, next)
          this.dirty = true
          if (key === 'messageIds' || Array.isArray(target)) {
            this.membersChanged = true
          }
          if (proxy === this.marks) {
            if (key === 'latestStop') {
              this.stopVersion++
            }
            if (key === 'cleared') {
              this.clearVersion++
              this.membersChanged = true
            }
            this.identify()
          }
        }
        return true
      },
      deleteProperty: (target, key) => {
        Reflect.deleteProperty(target, key)
        this.dirty = true
        if (proxy === this.marks && key === 'cleared') {
          this.clearVersion++
          this.membersChanged = true
        }
        return true
      }
    })
    this.wrapped.set(value, proxy)
    this.wrapped.set(proxy, proxy)
    return proxy
  }
}
