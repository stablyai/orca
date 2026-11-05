import { createPtyExitPayload, emitPtyListeners } from './daemon-pty-listener-emission'
import { probeDaemonSocket } from './daemon-launch-paths'
import { WSL_DISTRO_LOSS_EXIT_CODE } from './daemon-wsl-bridge-exit'
import { DaemonPtyCheckpointPersistence } from './daemon-pty-checkpoint-persistence'

// Two probes a second apart: a dead host's pipe is gone at once, a live one answers within the first.
const HOST_LOSS_PROBE_DELAYS_MS = [500, 1_500] as const
// The same code a lost WSL distro reports: the pane keeps its tab and restorable history.
const HOST_LOSS_EXIT_CODE = WSL_DISTRO_LOSS_EXIT_CODE

/** Ends the PTYs of a host this adapter cannot respawn once that host's endpoint stays gone. */
export abstract class DaemonPtyLegacyHostLoss extends DaemonPtyCheckpointPersistence {
  /** A host this adapter cannot respawn (a previous-protocol host kept across an update) that dies took every
   * PTY with it. Without this its panes kept showing connected with a frozen last frame (2026-10-28: 21 agent
   * tabs). Report host loss once the endpoint stays unreachable; history stays open so each pane can restore. */
  protected async reportHostLossIfEndpointGone(): Promise<void> {
    for (const delayMs of HOST_LOSS_PROBE_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
      if (this.activeSessionIds.size === 0 || (await this.probeEndpoint(this.socketPath))) {
        return
      }
    }
    console.warn(
      `[daemon] host at ${this.socketPath} is gone; ${this.activeSessionIds.size} sessions reported lost`
    )
    // Deleting the entry being visited is safe while iterating a Set.
    for (const sessionId of this.activeSessionIds) {
      const hostLoss = {
        code: HOST_LOSS_EXIT_CODE,
        incarnationId: this.sessionIncarnations.get(sessionId),
        hostLost: true as const
      }
      this.hostLossSessionIds.add(sessionId)
      this.clearExitedSessionState(sessionId, hostLoss.code, hostLoss.incarnationId, {
        closeHistory: false
      })
      emitPtyListeners(this.exitListeners, (listener) =>
        listener(createPtyExitPayload(sessionId, hostLoss))
      )
    }
  }

  /** Overridable for tests. */
  protected probeEndpoint(socketPath: string): Promise<boolean> {
    return probeDaemonSocket(socketPath)
  }
}
