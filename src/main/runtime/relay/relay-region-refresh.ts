import { RelayHttpError, requestRelayAssignment, type RelayAssignment } from './relay-http-client'
import type {
  RelayRegionCorrectionRequest,
  RelayRegionDecision,
  RelayRegionWindow
} from './relay-region-correction-protocol'

type RefreshOptions = {
  directorUrl: string
  relayHostId: string
  token: () => string | undefined
  assignment: () => RelayAssignment | null
  isCurrent: () => boolean
  isOnline: () => boolean
  applyAssignment: (assignment: RelayAssignment) => boolean
  measure: (window: RelayRegionWindow) => Promise<RelayRegionDecision>
  fetch?: typeof globalThis.fetch
  now?: () => number
  random?: () => number
}

const HOUR = 60 * 60_000

export class RelayRegionRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private report: Extract<RelayRegionCorrectionRequest, { action: 'report' }> | null = null
  private window: RelayRegionWindow | null = null
  private closed = false
  private nextDeadline = 0

  constructor(private readonly options: RefreshOptions) {}

  start(assignment: RelayAssignment): void {
    this.window = assignment.regionCorrection?.window ?? null
    if (this.window) {
      this.checkDeadline()
    } else {
      this.schedule(HOUR)
    }
  }

  checkDeadline(): void {
    if (!this.isCurrent() || this.pending) {
      return
    }
    if (this.now() < this.nextDeadline) {
      if (!this.timer) {
        this.schedule(Math.min(HOUR, this.nextDeadline - this.now()))
      }
      return
    }
    if (!this.options.isOnline()) {
      this.schedule(60_000)
      return
    }
    this.pending = this.refresh().finally(() => {
      this.pending = null
    })
  }

  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.report = null
    this.window = null
  }

  private async exchange(regionCorrection: RelayRegionCorrectionRequest): Promise<RelayAssignment> {
    const token = this.options.token()
    if (!token) {
      throw new Error('relay_region_authorization_unavailable')
    }
    const assignment = await requestRelayAssignment({
      directorUrl: this.options.directorUrl,
      relayHostId: this.options.relayHostId,
      relayToken: token,
      reconnect: true,
      regionCorrection,
      isCurrent: () => this.isCurrent(),
      fetch: this.options.fetch
    })
    if (!this.isCurrent()) {
      throw new Error('stale_relay_region_refresh')
    }
    // The mode-bearing source drain owns migration activation; reports never rebind controls.
    this.options.applyAssignment(assignment)
    return assignment
  }

  private async refresh(): Promise<void> {
    try {
      const assignment = this.options.assignment()
      if (!assignment) {
        this.schedule(60_000)
        return
      }
      if (
        this.window &&
        (this.window.expiresAt <= this.now() ||
          this.window.assignmentEpoch !== assignment.assignmentEpoch)
      ) {
        this.window = null
        this.report = null
      }
      if (!this.window) {
        this.window =
          (await this.exchange({ v: 1, action: 'issue-window' })).regionCorrection?.window ?? null
      }
      const window = this.window
      if (!window) {
        this.schedule(HOUR)
        return
      }
      if (!this.report) {
        const decision = await this.options.measure(window)
        if (!this.isCurrent()) {
          return
        }
        this.report = {
          v: 1,
          action: 'report',
          generation: window.generation,
          assignmentEpoch: window.assignmentEpoch,
          policyVersion: 1,
          ...decision
        }
      }
      const report = this.report
      const response = await this.exchange(report)
      const accepted = response.regionCorrection?.reportStatus
      this.report = null
      this.window = null
      this.schedule(
        (accepted === 'accepted' || accepted === 'duplicate') && report.outcome === 'conclusive'
          ? 24 * HOUR
          : HOUR
      )
    } catch (error) {
      // Retry the same report/window: auth and healthy sockets are independent of probing.
      const retry = error instanceof RelayHttpError ? (error.retryAfterMs ?? 0) : 0
      this.schedule(Math.max(60_000, retry), retry)
    }
  }

  private schedule(delay: number, minimumDelay = 0): void {
    if (!this.isCurrent()) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    const jitter = 0.9 + (this.options.random ?? Math.random)() * 0.2
    const scheduledDelay = Math.max(minimumDelay, Math.ceil(delay * jitter))
    this.nextDeadline = this.now() + scheduledDelay
    this.timer = setTimeout(() => {
      this.timer = null
      this.checkDeadline()
    }, scheduledDelay)
    this.timer.unref?.()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent()
  }
}
