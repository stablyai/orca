import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, type ListSessionsResult } from './types'

export abstract class DaemonPtyIdleRetirement extends DaemonPtyDaemonRecovery {
  private retirementConfirmed = false
  private retirementIdentity: DaemonEndpointIdentity | null = null
  private retirementRequest: Promise<boolean> | null = null

  async canHandoffHistoryTo(current: DaemonPtyIdleRetirement, sessionId: string): Promise<boolean> {
    if (
      !this.historyManager ||
      !current.historyManager ||
      !this.historyManager.sharesStorageWith(current.historyManager)
    ) {
      return false
    }
    try {
      const result = await this.historyReader?.detectColdRestoreState(sessionId)
      return result?.status === 'restored' && !result.hasUnreadableRecovery
    } catch {
      return false
    }
  }

  async retireIfIdle(current: DaemonPtyIdleRetirement): Promise<boolean> {
    if (this.retirementConfirmed) {
      const identity = this.client.getDaemonIdentity()
      if (
        !this.client.isConnected() ||
        (identity &&
          this.retirementIdentity &&
          sameEndpointIdentity(identity, this.retirementIdentity))
      ) {
        return this.canReleaseHistoryTo(current)
      }
      this.retirementConfirmed = false
    }
    if (!this.retirementRequest) {
      this.retirementRequest = this.requestIdleRetirement(current).finally(() => {
        this.retirementRequest = null
      })
    }
    return (await this.retirementRequest) && this.canReleaseHistoryTo(current)
  }

  private async requestIdleRetirement(current: DaemonPtyIdleRetirement): Promise<boolean> {
    if (
      this.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION ||
      !this.client.isConnected() ||
      !this.canReleaseHistoryTo(current)
    ) {
      return false
    }
    try {
      // Preserve raw inventory: filtered live rows cannot prove physical emptiness.
      const inventory = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        250
      )
      if (
        !Array.isArray(inventory?.sessions) ||
        inventory.sessions.length !== 0 ||
        !this.canReleaseHistoryTo(current)
      ) {
        return false
      }
      const identity = this.client.getDaemonIdentity()
      const result = await this.client.request<{ retiring?: boolean }>(
        'shutdownIfIdle',
        undefined,
        250
      )
      this.retirementConfirmed = result?.retiring === true
      this.retirementIdentity = this.retirementConfirmed ? identity : null
      return this.retirementConfirmed && this.canReleaseHistoryTo(current)
    } catch {
      return false
    }
  }

  private canReleaseHistoryTo(current: DaemonPtyIdleRetirement): boolean {
    // Disk history stays owned by the same reader; no dispose, acknowledgement, or metadata rewrite.
    return (
      this.historyManager !== null &&
      current.historyManager !== null &&
      this.historyManager.sharesStorageWith(current.historyManager) &&
      this.historyManager.canReleaseOwnership() &&
      this.coldRestoreCache.byteSize === 0 &&
      this.sleepRestoreSessionIds.size === 0 &&
      this.historySpawnLocks.size === 0 &&
      this.keepHistoryShutdowns.size === 0 &&
      this.checkpointInFlight === null &&
      this.pendingSpawnOperationsBySessionId.size === 0 &&
      this.pendingClaimSpawnOperations.size === 0
    )
  }
}
