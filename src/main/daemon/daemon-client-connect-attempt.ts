import { DaemonProtocolError } from './daemon-errors'
import { waitForDaemonConnectionAttempt } from './daemon-client-socket-connect'

/**
 * The single connect attempt a daemon client may have dialing, and the endpoint generation
 * it dials for. Concurrent callers — simultaneous pane mounts all calling ensureConnected —
 * join the one attempt instead of racing sockets into "Connection lost".
 *
 * Why generation-aware: a disconnect, a daemon respawn above all, retires the endpoint an
 * in-flight attempt is dialing. Left standing as current, that attempt answers callers who
 * arrived after the replacement was published, and its dead-endpoint ENOENT reads as "the
 * daemon is gone" — forking a second respawn on top of the one that superseded it.
 */
export class DaemonConnectAttempt {
  private attempt: Promise<void> | null = null
  private attemptGeneration = 0

  hasInFlight(): boolean {
    return this.attempt !== null
  }

  /**
   * Connects, or joins whoever is already connecting. A retired attempt is waited out —
   * one attempt at a time keeps the client's socket fields single-owner — and then replaced
   * by a dial to the daemon that took its place.
   */
  async run(args: {
    isConnected: () => boolean
    currentGeneration: () => number
    connect: (attemptGeneration: number) => Promise<void>
    joinTimeoutMs: number
  }): Promise<void> {
    for (;;) {
      if (args.isConnected()) {
        return
      }
      const inFlight = this.attempt
      if (inFlight) {
        if (this.attemptGeneration === args.currentGeneration()) {
          return await waitForDaemonConnectionAttempt(inFlight, args.joinTimeoutMs)
        }
        await inFlight.catch(() => {})
        this.release(inFlight)
        continue
      }

      const generation = args.currentGeneration()
      const attempt = args.connect(generation)
      this.attempt = attempt
      this.attemptGeneration = generation
      try {
        await attempt
        return
      } catch (error) {
        // Why: the disconnect is the truthful failure here. Reported raw, the retired
        // endpoint's ENOENT reads as a daemon that is gone rather than one replaced.
        throw generation === args.currentGeneration()
          ? error
          : new DaemonProtocolError('Disconnected')
      } finally {
        this.release(attempt)
      }
    }
  }

  private release(attempt: Promise<void>): void {
    if (this.attempt === attempt) {
      this.attempt = null
    }
  }
}
