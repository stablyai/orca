import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

const LEDGER_FILE = '.incognito-sessions.json'
/** A corrupt/unreadable ledger is renamed to this prefix; its presence is the DURABLE distrust marker. */
const PRESERVED_PREFIX = `${LEDGER_FILE}.unreadable-`

/**
 * Durable "do-not-record" list of incognito ("no-session") session ids.
 *
 * Why persist: a daemon/app restart replaces the daemon and re-adopts (or revives) the still-live
 * shell under the SAME session id, on a fresh HistoryManager whose in-memory mark is gone — which is
 * exactly how an incognito terminal silently started recording again after a restart. Loading this
 * ledger on startup means openSession/registerWriter recognize that id and keep writing nothing.
 *
 * It stores ONLY opaque session ids (which already encode the worktree/cwd, the same as a normal
 * history dir name) — never scrollback. It is a privacy-protecting record, the inverse of capture.
 */
export class IncognitoSessionLedger {
  private readonly ids = new Set<string>()
  /** Subset of `ids` proven to be on disk, so a transient persist failure is retried, not forgotten. */
  private readonly persisted = new Set<string>()
  private readonly path: string
  /** `has()` is no longer authoritative (the do-not-record ids are lost or incomplete), so re-adopts
   *  must fail closed. Set from a corrupt load AND from a preserved sibling, so distrust is DURABLE
   *  across restarts — not just for this process's life. */
  private untrusted = false
  /** This load read a corrupt MAIN ledger that still needs renaming aside (persist() does it once). A
   *  pre-existing sibling means preservation already happened, so the valid main file is NOT renamed. */
  private corruptMainPending = false

  constructor(basePath: string) {
    this.path = join(basePath, LEDGER_FILE)
    // Durable distrust: a `.unreadable-*` sibling preserved by a PAST corruption means the id list may
    // still be incomplete (the lost ids were never recovered). Honour it on every load so a restart
    // after corruption keeps failing closed — the in-memory flag alone would reset on restart, letting
    // the fresh-but-lossy ledger be trusted and formerly-private re-adopts record.
    if (this.hasPreservedSibling()) {
      this.untrusted = true
    }
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
        if (!Array.isArray(parsed)) {
          throw new Error('ledger is not a JSON array of ids')
        }
        for (const id of parsed) {
          // A non-string element means corruption damaged the array; the id list can no longer be
          // trusted as complete, so reject the whole file rather than accept a partial list.
          if (typeof id !== 'string') {
            throw new Error('ledger contains a non-string id')
          }
          this.ids.add(id)
          // Loaded from disk → already durable; do not re-persist these on the next mark().
          this.persisted.add(id)
        }
      } catch {
        // A ledger that EXISTS but is unreadable / not a valid id array is a privacy hazard, not a
        // benign empty start: the ids of the sessions to keep NOT recording are now unknown, so a
        // re-adopted terminal would be treated as normal and recorded. Mark untrusted (fail CLOSED
        // for re-adopts, see HistoryManager) and preserve the file (see persist()) as the durable marker.
        this.untrusted = true
        this.corruptMainPending = true
      }
    }
    if (this.untrusted) {
      console.error(
        `[history] incognito ledger at ${this.path} is unreadable/invalid or a prior corruption was preserved — its private-session ids may be lost; re-adopted terminals will NOT be recorded. Remove ${this.path}.unreadable-* once you have confirmed no private session is at risk.`
      )
    }
  }

  /** Does a preserved `.unreadable-*` sibling from a past corruption exist next to the ledger? */
  private hasPreservedSibling(): boolean {
    try {
      return readdirSync(dirname(this.path)).some((name) => name.startsWith(PRESERVED_PREFIX))
    } catch {
      return false
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId)
  }

  /** The on-disk ledger existed but could not supply trustworthy ids. While true, callers must fail
   *  CLOSED: treat a re-adopted session (no explicit non-incognito flag) as do-not-record, because it
   *  may be one of the lost incognito ids. A fresh, explicitly non-incognito session is unaffected. */
  isUntrusted(): boolean {
    return this.untrusted
  }

  /**
   * Whether a terminal's scrollback must NOT be captured: it is genuinely incognito (explicit flag or
   * a ledger id), OR the ledger is untrusted and this is not an explicitly non-incognito session (a
   * re-adopt whose provenance we can no longer prove — fail closed). `explicit` is the caller's
   * incognito flag, `undefined` on a re-adopt. This decides suppression only; the caller marks a
   * genuine incognito id durably (an untrusted-only re-adopt is suppressed without being marked).
   */
  suppressesCapture(sessionId: string, explicit?: boolean): boolean {
    return explicit === true || this.has(sessionId) || (explicit !== false && this.untrusted)
  }

  /**
   * Record an incognito session id and report whether it is now DURABLE on disk.
   *
   * The durable ledger is the ONLY thing that keeps a session incognito across a daemon/app
   * restart: a restart re-adopts or revives the still-live shell under the same id on a fresh
   * HistoryManager, and if that id is not in the ledger a normal writer is created and the shell's
   * new output lands in output.log. A silently-swallowed write therefore defeats the whole feature,
   * so callers must act on a `false` return (the caller surfaces it via the write-error path) rather
   * than assume suppression survived. Retries on every call for an id not yet proven on disk.
   */
  mark(sessionId: string): boolean {
    this.ids.add(sessionId)
    if (this.persisted.has(sessionId)) {
      return true
    }
    return this.persist()
  }

  forget(sessionId: string): void {
    const removed = this.ids.delete(sessionId)
    this.persisted.delete(sessionId)
    if (removed) {
      this.persist()
    }
  }

  private persist(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Preserve a corrupt MAIN ledger before the first overwrite clobbers it: its ids may be
      // recoverable, and the renamed sibling is ALSO the durable distrust marker that keeps future
      // loads failing closed (see constructor). Only the main file this load found corrupt is renamed
      // — never a valid-but-lossy ledger written after a prior corruption. A durable marker MUST exist
      // before we overwrite with the (lossy) in-memory set, or a later load would trust it; if we
      // cannot guarantee one, throw so persist() reports failure and leaves the corrupt file in place.
      if (this.corruptMainPending) {
        this.corruptMainPending = false
        const marker = join(dirname(this.path), `${PRESERVED_PREFIX}${Date.now()}`)
        try {
          renameSync(this.path, marker)
        } catch {
          // The corrupt file could not be moved aside (un-renamable, or already gone). Still leave a
          // durable distrust marker so the lossy ledger we write below is not trusted after a restart.
          // If even this throws, it propagates to the outer catch → persist() returns false without
          // overwriting, and the corrupt file (if still present) remains as the marker.
          if (!this.hasPreservedSibling()) {
            writeFileSync(marker, '', { mode: 0o600 })
          }
        }
      }
      // Why tmp+rename: a torn write must not corrupt the ledger; a stale-but-whole one is recoverable.
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.ids]), { mode: 0o600 })
      renameSync(tmp, this.path)
      // The whole set is now on disk; re-sync the durable mirror.
      this.persisted.clear()
      for (const id of this.ids) {
        this.persisted.add(id)
      }
      return true
    } catch {
      // Durability failed. In-memory gating still holds for THIS process, but a restart would not be
      // suppressed. Fail LOUD here — the single persist chokepoint — so the loss is surfaced even
      // when the HistoryManager was built with no onWriteError (production constructs it bare); the
      // caller is told via the `false` return rather than left assuming the write succeeded.
      console.error(
        `[history] incognito ledger at ${this.path} could NOT be persisted — a daemon/app restart may re-adopt these private sessions and start recording them`
      )
      return false
    }
  }
}
