import {
  pruneRetiredPtyIncarnations,
  type RetiredPtyIncarnation
} from '../../shared/retired-pty-incarnations'
import type { Session } from './session'

const REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS = 2_000

/**
 * Exit evidence for sessions that have already been reaped, so a remote
 * foreground probe that arrives just after an exit is answered rather than told
 * the id never existed.
 */
export class TerminalHostRetiredIncarnations {
  private readonly entries = new Map<string, RetiredPtyIncarnation>()

  record(sessionId: string, session: Session): void {
    pruneRetiredPtyIncarnations(this.entries)
    this.entries.set(sessionId, {
      incarnationId: session.incarnationId,
      code: session.exitCode ?? 0,
      expiresAt: Date.now() + REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS
    })
  }

  get(sessionId: string): RetiredPtyIncarnation | undefined {
    return this.entries.get(sessionId)
  }

  /** Whether unexpired exit evidence for `sessionId` names exactly this incarnation. */
  answersFor(sessionId: string, expectedIncarnationId: string | undefined): boolean {
    pruneRetiredPtyIncarnations(this.entries)
    const entry = this.entries.get(sessionId)
    return (entry?.expiresAt ?? 0) > Date.now() && expectedIncarnationId === entry?.incarnationId
  }
}
