import type { PtySpawnResult } from '../pty/spawn-result'
import type { RexLaunchPayloadFactory } from './rex-launch-worker'
import type { RexSessionStore } from './rex-session-store'
import type { RexSnapshotDecoder } from './rex-reattach'
import { RexFreshPtyProvider } from './rex-fresh-pty-provider'
import { captureRexSnapshot, rexSnapshotSpawnResult } from './rex-capture-snapshot'

export class RexSnapshotPtyProvider extends RexFreshPtyProvider {
  constructor(
    socketPath: string,
    store: RexSessionStore,
    protected readonly snapshotDecoder: RexSnapshotDecoder,
    preparePayload?: RexLaunchPayloadFactory
  ) {
    super(socketPath, store, preparePayload)
  }

  protected async captureActive(id: string): Promise<PtySpawnResult> {
    const session = this.sessions.get(id)
    if (
      !session ||
      session.control.isClosed ||
      session.closing ||
      session.exitCode !== undefined ||
      this.pendingRestore.has(id) ||
      this.restoring.has(id)
    ) {
      throw new Error('Rex active capture unavailable')
    }
    this.restoring.add(id)
    // Stop old output before requesting the replacement snapshot. Never combine the old
    // buffered stream with the new snapshot. The new snapshot covers the intervening output.
    try {
      session.data.close()
      const opened = await captureRexSnapshot(this.socketPath, session, this.snapshotDecoder)
      await this.store.retirements.assertAvailable(session.record).catch((error) => {
        opened.data.close()
        throw error
      })
      if (session.control.isClosed || session.closing || this.sessions.get(id) !== session) {
        opened.data.close()
        throw new Error('Rex disconnected during active capture')
      }
      session.data = opened.data
      session.lost = false
      this.pendingRestore.set(
        id,
        {
          tail: opened.tail,
          nonce: opened.nonce,
          continuation: opened.snapshot.continuation
        },
        () => this.markLost(session, true)
      )
      return {
        ...rexSnapshotSpawnResult(session.record, opened.snapshot),
        attachedGrid: { cols: opened.snapshot.cols, rows: opened.snapshot.rows }
      }
    } catch (error) {
      this.markLost(session, true)
      throw error
    } finally {
      this.restoring.delete(id)
    }
  }
}
