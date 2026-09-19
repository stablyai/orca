import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'

export class DaemonRouterRetirement {
  admissionClosed = false
  spawnInFlight = 0
  private retirementAttempted = false
  private idleRetirementPromise: Promise<DaemonIdleRetirementResult> | null = null

  constructor(private readonly allAdapters: () => DaemonPtyAdapter[]) {}

  async requestIdleRetirement(): Promise<DaemonIdleRetirementResult> {
    if (this.idleRetirementPromise) {
      return this.idleRetirementPromise
    }
    this.admissionClosed = true
    const request = this.finishIdleRetirementRequest().finally(() => {
      if (this.idleRetirementPromise === request) {
        this.idleRetirementPromise = null
      }
    })
    this.idleRetirementPromise = request
    return request
  }

  private async finishIdleRetirementRequest(): Promise<DaemonIdleRetirementResult> {
    const adapters = this.allAdapters()
    if (this.spawnInFlight > 0) {
      this.admissionClosed = this.retirementAttempted
      return { state: 'busy', liveSessions: null }
    }
    if (adapters.some((adapter) => adapter.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION)) {
      this.admissionClosed = this.retirementAttempted
      return { state: 'unsupported' }
    }
    const inventories = await Promise.allSettled(adapters.map((adapter) => adapter.listSessions()))
    if (inventories.some((inventory) => inventory.status === 'rejected')) {
      this.admissionClosed = this.retirementAttempted
      return { state: 'unverifiable' }
    }
    const liveSessions = inventories.reduce(
      (count, inventory) =>
        count +
        (inventory.status === 'fulfilled'
          ? inventory.value.filter((session) => session.isAlive).length
          : 0),
      0
    )
    if (liveSessions > 0) {
      this.admissionClosed = this.retirementAttempted
      return {
        state: 'busy',
        liveSessions,
        ...(!this.retirementAttempted && !adapters.some((adapter) => adapter.recoveryOnly)
          ? { admissionReopened: true as const }
          : {})
      }
    }
    this.retirementAttempted = true
    const results = await Promise.all(adapters.map((adapter) => adapter.requestIdleRetirement()))
    if (results.every((result) => result.state === 'retiring')) {
      return { state: 'retiring' }
    }
    const refusedLiveSessions = results.reduce(
      (count, result) => count + (result.state === 'busy' ? (result.liveSessions ?? 0) : 0),
      0
    )
    if (refusedLiveSessions > 0) {
      return { state: 'busy', liveSessions: refusedLiveSessions }
    }
    return { state: 'unverifiable' }
  }
}
