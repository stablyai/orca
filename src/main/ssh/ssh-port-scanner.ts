import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { DetectedPort } from '../../shared/ssh-types'

// Why: every tick walks /proc/*/fd on the remote relay, so cadence is remote
// CPU, not just a local timer. 12s cuts steady-state request volume 4x vs the
// old 3s while keeping new-port detection well under the 30s workspace-scanner
// cadence users already accept.
export const SSH_PORT_SCAN_BASE_INTERVAL_MS = 12_000
// Why: idle backoff cap — an unchanged port set doubles the interval up to
// this bound, so a quiet remote costs two scans per minute instead of twenty
// without exceeding the existing workspace-port scanner's visible cadence.
export const SSH_PORT_SCAN_MAX_INTERVAL_MS = 30_000

export type PortScannerWindowVisibility = {
  isWindowVisible: () => boolean
  // Fires when a hidden/minimized window is shown again; returns unsubscribe.
  onWindowBecameVisible: (listener: () => void) => () => void
}

type ScanHandle = {
  timer: ReturnType<typeof setTimeout> | null
  intervalMs: number
  // Why: while the window is hidden the scan chain is parked outright — no
  // timer wakeups, no remote requests — and the visibility listener resumes
  // it with an immediate scan so ports opened while hidden surface at once.
  parkedWhileHidden: boolean
  unsubscribeVisibility: () => void
  // Why: keyed by "host:port" (not just port) so that host-distinct listeners
  // on the same port (e.g. 127.0.0.1:3000 + 0.0.0.0:3000) are tracked separately.
  previousPorts: Map<string, DetectedPort>
  // Why: ports detected on the first scan are pre-existing services (sshd, system
  // daemons) that the user didn't just start. VS Code calls these "initialCandidates"
  // and excludes them from auto-forward suggestions (Phase 3).
  initialPorts: Set<string> | null
}

export class PortScanner {
  private handles = new Map<string, ScanHandle>()

  constructor(private visibility: PortScannerWindowVisibility) {}

  startScanning(
    targetId: string,
    mux: SshChannelMultiplexer,
    onChanged: (targetId: string, ports: DetectedPort[], platform: string) => void
  ): void {
    this.stopScanning(targetId)

    const handle: ScanHandle = {
      timer: null,
      intervalMs: SSH_PORT_SCAN_BASE_INTERVAL_MS,
      parkedWhileHidden: false,
      unsubscribeVisibility: () => {},
      previousPorts: new Map(),
      initialPorts: null
    }
    const isCurrent = (): boolean => this.handles.get(targetId) === handle

    // Why: guard against overlapping scans. The timer chain only reschedules
    // after a poll completes, but the visibility-resume path can race a poll
    // still in flight on a slow remote.
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) {
        return
      }
      polling = true
      try {
        const result = (await mux.request('ports.detect')) as {
          ports: DetectedPort[]
          platform: string
        }

        if (!isCurrent()) {
          return
        }

        const currentPorts = new Map<string, DetectedPort>()
        for (const p of result.ports) {
          currentPorts.set(`${p.host}:${p.port}`, p)
        }

        if (handle.initialPorts === null) {
          handle.initialPorts = new Set(currentPorts.keys())
        }

        if (!portsEqual(handle.previousPorts, currentPorts)) {
          handle.previousPorts = currentPorts
          handle.intervalMs = SSH_PORT_SCAN_BASE_INTERVAL_MS
          onChanged(targetId, result.ports, result.platform)
        } else {
          handle.intervalMs = Math.min(handle.intervalMs * 2, SSH_PORT_SCAN_MAX_INTERVAL_MS)
        }
      } catch {
        // Relay disconnected or request timed out — retry on next interval
      } finally {
        polling = false
      }
    }

    const tick = async (): Promise<void> => {
      handle.timer = null
      if (!isCurrent()) {
        return
      }
      if (!this.visibility.isWindowVisible()) {
        handle.parkedWhileHidden = true
        return
      }
      await poll()
      if (!isCurrent()) {
        return
      }
      handle.timer = setTimeout(() => void tick(), handle.intervalMs)
    }

    handle.unsubscribeVisibility = this.visibility.onWindowBecameVisible(() => {
      if (!isCurrent() || !handle.parkedWhileHidden) {
        return
      }
      handle.parkedWhileHidden = false
      void tick()
    })

    this.handles.set(targetId, handle)
    void tick()
  }

  getDetectedPorts(targetId: string): DetectedPort[] {
    const handle = this.handles.get(targetId)
    if (!handle) {
      return []
    }
    return Array.from(handle.previousPorts.values())
  }

  stopScanning(targetId: string): void {
    const handle = this.handles.get(targetId)
    if (!handle) {
      return
    }
    if (handle.timer) {
      clearTimeout(handle.timer)
    }
    handle.unsubscribeVisibility()
    this.handles.delete(targetId)
  }

  dispose(): void {
    for (const [targetId] of this.handles) {
      this.stopScanning(targetId)
    }
  }
}

function portsEqual(a: Map<string, DetectedPort>, b: Map<string, DetectedPort>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [key, entryA] of a) {
    const entryB = b.get(key)
    if (!entryB) {
      return false
    }
    if (entryA.pid !== entryB.pid || entryA.processName !== entryB.processName) {
      return false
    }
  }
  return true
}
