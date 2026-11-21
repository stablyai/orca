import type { CodexAppServerConnection } from '../codex-app-server-connection-types'

/** Frames all paused chats on one server may hold in Orca before the server itself waits. */
export const CODEX_SHARED_SERVER_BACKLOG_BYTES = 32 * 1024 * 1024
/** How long one stalled chat may hold every chat on its server before it alone is dropped. */
export const CODEX_SHARED_SERVER_STALL_MS = 20_000

type Lagging = { readonly backlogBytes: number; shed: () => void }

/** Bytes queued by the paused chats on one server. Past the budget the shared reader pauses, so
 *  Codex waits as it would on a dedicated chat's pipe and memory stays bounded however many chats
 *  stall. A chat still holding the server after the stall window is dropped (it reconnects). */
export class CodexSharedServerBacklog {
  private total = 0
  private paused = false
  private stallTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly reader: () => Pick<
      CodexAppServerConnection,
      'pauseReading' | 'resumeReading'
    > | null,
    private readonly leases: Iterable<Lagging>
  ) {}

  change(deltaBytes: number): void {
    this.total += deltaBytes
    if (!this.paused && this.total > CODEX_SHARED_SERVER_BACKLOG_BYTES) {
      this.paused = true
      this.reader()?.pauseReading?.()
      this.armStall()
    } else if (this.paused && this.total <= CODEX_SHARED_SERVER_BACKLOG_BYTES / 2) {
      this.resume()
    }
  }

  dispose(): void {
    clearTimeout(this.stallTimer)
    this.paused = false
    this.total = 0
  }

  private armStall(): void {
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined
      if (!this.paused) {
        return
      }
      let largest: Lagging | undefined
      for (const lease of this.leases) {
        if (lease.backlogBytes > (largest?.backlogBytes ?? 0)) {
          largest = lease
        }
      }
      largest?.shed()
      if (this.paused) {
        this.armStall()
      }
    }, CODEX_SHARED_SERVER_STALL_MS)
    this.stallTimer.unref?.()
  }

  private resume(): void {
    this.paused = false
    clearTimeout(this.stallTimer)
    this.stallTimer = undefined
    this.reader()?.resumeReading?.()
  }
}
