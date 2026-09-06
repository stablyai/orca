import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES } from '../../../src/shared/mobile-web/terminal-stream-contract'

export type MobileWebPackageSource = 'none' | 'verified-cache' | 'desktop-refresh'
export type MobileWebPackageStatus = 'idle' | 'loading' | 'active' | 'warning' | 'unavailable'
export type MobileWebHealthStatus = 'none' | 'pending' | 'healthy' | 'restarted' | 'recovered'
export type MobileWebTerminalResyncReason =
  | 'gap'
  | 'overflow'
  | 'foreground'
  | 'reconnect'
  | 'webview-restored'
  | 'snapshot-invalid'
  | 'flow-overflow'

export type MobileWebTerminalFlowMetrics = {
  ackLagMs: number | undefined
  outstandingBytes: number
}

export type MobileWebDiagnosticsSnapshot = {
  bridgeVersion: number
  buildId: string | null
  packageSource: MobileWebPackageSource
  packageStatus: MobileWebPackageStatus
  activationMs: number | null
  refreshMs: number | null
  healthStatus: MobileWebHealthStatus
  recoveryCount: number
  terminalResyncCount: number
  terminalOverflowCount: number
  terminalAckLagMaxMs: number | null
  terminalOutstandingBytesHighWater: number
  terminalLastResyncReason: MobileWebTerminalResyncReason | null
  lastFailureCode: string | null
}

const EMPTY_SNAPSHOT: MobileWebDiagnosticsSnapshot = Object.freeze({
  bridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  buildId: null,
  packageSource: 'none',
  packageStatus: 'idle',
  activationMs: null,
  refreshMs: null,
  healthStatus: 'none',
  recoveryCount: 0,
  terminalResyncCount: 0,
  terminalOverflowCount: 0,
  terminalAckLagMaxMs: null,
  terminalOutstandingBytesHighWater: 0,
  terminalLastResyncReason: null,
  lastFailureCode: null
})

export class MobileWebDiagnosticsStore {
  private readonly snapshots = new Map<string, MobileWebDiagnosticsSnapshot>()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(hostId: string | null | undefined): MobileWebDiagnosticsSnapshot {
    return hostId ? (this.snapshots.get(hostId) ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT
  }

  begin(hostId: string): void {
    this.set(hostId, { ...EMPTY_SNAPSHOT, packageStatus: 'loading' })
  }

  sessionReady(
    hostId: string,
    buildId: string,
    packageSource: MobileWebPackageSource,
    activationMs?: number
  ): void {
    const previous = this.get(hostId)
    this.set(hostId, {
      ...previous,
      buildId: safeBuildId(buildId),
      packageSource,
      packageStatus: 'active',
      activationMs: safeDurationMs(activationMs),
      healthStatus: 'pending',
      lastFailureCode: null
    })
  }

  refreshSucceeded(hostId: string, refreshMs?: number): void {
    this.patch(hostId, {
      packageStatus: 'active',
      refreshMs: safeDurationMs(refreshMs),
      lastFailureCode: null
    })
  }

  warning(hostId: string, failureCode: string): void {
    const previous = this.get(hostId)
    this.patch(hostId, {
      packageStatus: previous.buildId ? 'warning' : 'unavailable',
      lastFailureCode: safeFailureCode(failureCode)
    })
  }

  healthy(hostId: string, buildId: string): void {
    if (this.get(hostId).buildId !== safeBuildId(buildId)) {
      return
    }
    this.patch(hostId, {
      packageStatus: 'active',
      healthStatus: 'healthy',
      lastFailureCode: null
    })
  }

  restarted(hostId: string, buildId: string): void {
    if (this.get(hostId).buildId !== safeBuildId(buildId)) {
      return
    }
    this.patch(hostId, {
      packageStatus: 'warning',
      healthStatus: 'restarted',
      lastFailureCode: 'webview_process_terminated'
    })
  }

  recovered(hostId: string, buildId: string, failureCode: string): void {
    const previous = this.get(hostId)
    this.set(hostId, {
      ...previous,
      buildId: safeBuildId(buildId),
      packageSource: 'verified-cache',
      packageStatus: 'warning',
      healthStatus: 'recovered',
      recoveryCount: boundedIncrement(previous.recoveryCount),
      lastFailureCode: safeFailureCode(failureCode)
    })
  }

  terminalResync(hostId: string, reason: MobileWebTerminalResyncReason): void {
    const previous = this.get(hostId)
    this.patch(hostId, {
      terminalResyncCount: boundedIncrement(previous.terminalResyncCount),
      terminalOverflowCount:
        reason === 'flow-overflow'
          ? boundedIncrement(previous.terminalOverflowCount)
          : previous.terminalOverflowCount,
      terminalLastResyncReason: reason
    })
  }

  terminalFlow(hostId: string, metrics: MobileWebTerminalFlowMetrics): void {
    const ackLagMs = safeDurationMs(metrics.ackLagMs)
    const outstandingBytes = safeTerminalOutstandingBytes(metrics.outstandingBytes)
    if (ackLagMs === null && outstandingBytes === null) {
      return
    }
    const previous = this.get(hostId)
    this.patch(hostId, {
      terminalAckLagMaxMs:
        ackLagMs === null
          ? previous.terminalAckLagMaxMs
          : Math.max(previous.terminalAckLagMaxMs ?? 0, ackLagMs),
      terminalOutstandingBytesHighWater:
        outstandingBytes === null
          ? previous.terminalOutstandingBytesHighWater
          : Math.max(previous.terminalOutstandingBytesHighWater, outstandingBytes)
    })
  }

  private patch(hostId: string, patch: Partial<MobileWebDiagnosticsSnapshot>): void {
    this.set(hostId, { ...this.get(hostId), ...patch })
  }

  private set(hostId: string, snapshot: MobileWebDiagnosticsSnapshot): void {
    this.snapshots.set(hostId, Object.freeze(snapshot))
    for (const listener of this.listeners) {
      listener()
    }
  }
}

function safeBuildId(buildId: string): string | null {
  return /^[a-f0-9]{64}$/.test(buildId) ? buildId : null
}

function safeFailureCode(failureCode: string): string {
  return /^[a-z0-9_]{1,64}$/.test(failureCode) ? failureCode : 'unknown'
}

function safeDurationMs(durationMs: number | undefined): number | null {
  return Number.isFinite(durationMs) && durationMs! >= 0 && durationMs! <= 120_000
    ? Math.round(durationMs!)
    : null
}

function safeTerminalOutstandingBytes(bytes: number): number | null {
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES
    ? bytes
    : null
}

function boundedIncrement(value: number): number {
  return Math.min(value + 1, 9_999)
}

export const mobileWebDiagnosticsStore = new MobileWebDiagnosticsStore()
