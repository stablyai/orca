import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { DetectedPort } from '../../shared/ssh-types'

const POLL_INTERVAL_MS = 3_000

type ScanHandle = {
  timer: ReturnType<typeof setInterval>
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

  startScanning(
    targetId: string,
    mux: SshChannelMultiplexer,
    onChanged: (targetId: string, ports: DetectedPort[], platform: string) => void
  ): void {
    this.stopScanning(targetId)

    const handle: ScanHandle = {
      timer: null!,
      previousPorts: new Map(),
      initialPorts: null
    }

    // Why: guard against overlapping scans. On slow remotes, /proc/*/fd walks
    // can take longer than POLL_INTERVAL_MS. Without this guard, setInterval
    // would stack up concurrent requests on the shared SSH multiplexer.
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

        if (!this.handles.has(targetId)) {
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
          onChanged(targetId, result.ports, result.platform)
        }
      } catch {
        // Relay disconnected or request timed out — retry on next interval
      } finally {
        polling = false
      }
    }

    handle.timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    this.handles.set(targetId, handle)

    void poll()
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
    clearInterval(handle.timer)
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
