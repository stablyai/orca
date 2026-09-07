import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import type { DaemonFileLog } from './daemon-file-log'
import {
  DaemonEndpointUnavailableError,
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonEndpointOwnershipState,
  type DaemonEndpointOwnershipState,
  type DaemonSocketIdentity
} from './daemon-endpoint-ownership'
import { probeSocketConnect } from './daemon-endpoint-probe'
import { unlinkOwnedDaemonPidFile, unlinkOwnedDaemonTokenFile } from './daemon-spawner'

type DaemonEndpointLifecycleOptions = {
  socketPath: string
  tokenPath: string
  pidPath: string | null
  launchNonce: string | null
  token: string
  publishEndpointOwnership: () => void
  log: DaemonFileLog
  isServing: () => boolean
  onOwnershipLost: () => void
}

export class DaemonEndpointLifecycle {
  private static readonly OWNERSHIP_POLL_MS = 30 * 1000
  private static readonly LOSS_CONFIRMATIONS = 2
  private ownedSocketIdentity: DaemonSocketIdentity | null = null
  private ownershipTimer: ReturnType<typeof setInterval> | null = null
  private ownershipLossStreak = 0
  private ownershipLost = false

  constructor(private readonly options: DaemonEndpointLifecycleOptions) {}

  bindPath(): string {
    return process.platform === 'win32'
      ? this.options.socketPath
      : getDaemonSocketBindPath(this.options.socketPath)
  }

  secureBindPath(bindPath: string): void {
    try {
      chmodSync(bindPath, 0o600)
    } catch {
      // Best-effort on platforms that support it.
    }
  }

  abandonBindPath(bindPath: string): void {
    if (process.platform === 'win32') {
      return
    }
    try {
      unlinkSync(bindPath)
    } catch {
      // Already consumed by publication, or never created.
    }
  }

  async publish(bindPath: string): Promise<void> {
    const outcome = await publishDaemonEndpoint(
      bindPath,
      this.options.socketPath,
      probeSocketConnect
    )
    if (outcome.status !== 'published') {
      this.options.log.log('endpoint-publish-declined', { reason: outcome.status })
      console.warn(`[daemon] Endpoint unavailable at startup: reason=${outcome.status}`)
      throw new DaemonEndpointUnavailableError(outcome.status)
    }
    this.ownedSocketIdentity = outcome.identity
    let publishedOwnership = false
    try {
      this.options.publishEndpointOwnership()
      publishedOwnership = true
      writeFileSync(this.options.tokenPath, this.options.token, { mode: 0o600 })
    } catch (error) {
      if (publishedOwnership && this.options.pidPath && this.options.launchNonce) {
        unlinkOwnedDaemonPidFile(this.options.pidPath, process.pid, this.options.launchNonce)
      }
      this.ownedSocketIdentity = null
      throw error
    }
  }

  retireUnstarted(): void {
    this.stopOwnershipWatch()
    this.unlinkOwnedArtifacts()
  }

  unlinkOwnedArtifacts(): void {
    unlinkOwnedDaemonTokenFile(this.options.tokenPath, this.options.token)
    if (this.options.pidPath && this.options.launchNonce) {
      unlinkOwnedDaemonPidFile(this.options.pidPath, process.pid, this.options.launchNonce)
    }
    // The canonical endpoint stays: removing it could delete a replacement's name.
    this.ownedSocketIdentity = null
  }

  stopOwnershipWatch(): void {
    if (this.ownershipTimer === null) {
      return
    }
    clearInterval(this.ownershipTimer)
    this.ownershipTimer = null
  }

  hasLostOwnership(): boolean {
    if (this.ownershipLost) {
      return true
    }
    return this.observeOwnership() === 'lost'
  }

  get lost(): boolean {
    return this.ownershipLost
  }

  requestRetirementForLoss(): void {
    const alreadyLost = this.ownershipLost
    this.ownershipLost = true
    this.ownedSocketIdentity = null
    if (!alreadyLost) {
      this.options.log.log('endpoint-ownership-lost', {
        socketPath: this.options.socketPath
      })
      console.warn(
        '[daemon] Endpoint ownership lost to another daemon — retiring once existing sessions end'
      )
    }
    this.stopOwnershipWatch()
    this.options.onOwnershipLost()
  }

  startOwnershipWatch(): void {
    if (process.platform === 'win32' || !this.ownedSocketIdentity) {
      return
    }
    this.ownershipTimer = setInterval(
      () => this.checkOwnership(),
      DaemonEndpointLifecycle.OWNERSHIP_POLL_MS
    )
    this.ownershipTimer.unref()
  }

  private checkOwnership(): void {
    if (process.platform === 'win32' || !this.ownedSocketIdentity) {
      return
    }
    if (this.observeOwnership() !== 'lost') {
      return
    }
    this.ownershipLossStreak++
    if (this.ownershipLossStreak >= DaemonEndpointLifecycle.LOSS_CONFIRMATIONS) {
      this.requestRetirementForLoss()
    }
  }

  private observeOwnership(): DaemonEndpointOwnershipState {
    if (process.platform === 'win32' || !this.ownedSocketIdentity || !this.options.isServing()) {
      return 'indeterminate'
    }
    const state = readDaemonEndpointOwnershipState(
      this.options.socketPath,
      this.ownedSocketIdentity
    )
    if (state !== 'lost') {
      this.ownershipLossStreak = 0
    }
    return state
  }
}
