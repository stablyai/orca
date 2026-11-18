import type {
  EmulatorActiveSession,
  EmulatorBackendKind,
  EmulatorSessionInfo
} from './emulator-types'
import type { EmulatorSessionState } from './emulator-bridge-types'
import type { EmulatorBackend } from './backends/emulator-backend'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { deriveAvccUrlFromStreamUrl } from './serve-sim-detached-session'

const DEVICE_LISTING_BUDGET_MS = 5_000

type CensusBackendForKind = (
  kind: EmulatorBackendKind
) => Pick<EmulatorBackend, 'listRunningDeviceIds' | 'stopHelperForDevice'> | null

export class EmulatorSessionRegistry {
  private readonly activeByWorktree = new Map<string, string>()
  private readonly sessions = new Map<string, EmulatorSessionState>()

  registerActive(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean; backend?: EmulatorBackendKind } = {}
  ): string[] {
    const key = info.deviceUdid
    const previous = this.sessions.get(key)
    const replaced =
      previous &&
      (previous.pid !== info.helperPid ||
        previous.streamUrl !== info.streamUrl ||
        previous.wsUrl !== info.wsUrl)
    const affected = replaced
      ? [...this.activeByWorktree].filter(([, activeKey]) => activeKey === key).map(([id]) => id)
      : []
    const next: EmulatorSessionState = {
      deviceUdid: info.deviceUdid,
      wsUrl: info.wsUrl,
      streamUrl: info.streamUrl,
      axUrl: info.axUrl,
      pid: info.helperPid,
      managed: options.managed === true,
      initialized: true,
      // Preserve iOS defaults for callers predating multiple backends.
      backend: info.backend ?? options.backend ?? 'ios',
      streamCodec: info.streamCodec ?? 'mjpeg'
    }
    if (
      !previous ||
      replaced ||
      previous.managed !== next.managed ||
      previous.backend !== next.backend ||
      previous.streamCodec !== next.streamCodec ||
      previous.axUrl !== next.axUrl
    ) {
      this.sessions.set(key, next)
    }
    this.activeByWorktree.set(worktreeId, key)
    return affected
  }

  restoreIfUnchanged(worktreeId: string, session: EmulatorSessionState): void {
    if (
      !this.activeByWorktree.has(worktreeId) &&
      this.sessions.get(session.deviceUdid) === session
    ) {
      this.activeByWorktree.set(worktreeId, session.deviceUdid)
    }
  }

  unregisterWorktree(worktreeId: string): void {
    this.activeByWorktree.delete(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    if (!worktreeId) {
      return null
    }
    const key = this.activeByWorktree.get(worktreeId)
    if (!key) {
      return null
    }
    const session = this.sessions.get(key)
    return session ? toSessionInfo(session) : null
  }

  getActiveSessionKey(worktreeId: string): string | null {
    return this.activeByWorktree.get(worktreeId) ?? null
  }

  getSession(key: string): EmulatorSessionState | undefined {
    return this.sessions.get(key)
  }

  sessionInfoOrTarget(key: string): EmulatorSessionInfo {
    const session = this.sessions.get(key)
    return session ? toSessionInfo(session) : { deviceUdid: key, streamUrl: '', wsUrl: '' }
  }

  getIosVideoStreamUrl(key: string): string | null {
    const session = this.sessions.get(key)
    return session?.backend === 'ios'
      ? (deriveAvccUrlFromStreamUrl(session.streamUrl) ?? null)
      : null
  }

  toSessionInfo(session: EmulatorSessionState): EmulatorSessionInfo {
    return toSessionInfo(session)
  }

  generationForDevice(deviceUdid: string): object | undefined {
    return this.sessions.get(deviceUdid)
  }

  isCurrentOwner(worktreeId: string, deviceUdid: string, generation: object | undefined): boolean {
    return (
      !!generation &&
      this.activeByWorktree.get(worktreeId) === deviceUdid &&
      this.sessions.get(deviceUdid) === generation
    )
  }

  hasActiveWorktreeForSession(key: string): boolean {
    return [...this.activeByWorktree.values()].some((activeKey) => activeKey === key)
  }

  /** One row per worktree's live session; a shared device appears once per worktree. */
  async listLiveActive(
    worktreeId: string | undefined,
    backendForKind: CensusBackendForKind
  ): Promise<EmulatorActiveSession[]> {
    await this.pruneGoneManagedSessions(backendForKind)
    const rows: EmulatorActiveSession[] = []
    for (const [activeWorktreeId, key] of this.activeByWorktree) {
      const session = this.sessions.get(key)
      if (session && (!worktreeId || activeWorktreeId === worktreeId)) {
        rows.push({
          worktreeId: activeWorktreeId,
          backend: session.backend,
          ...toSessionInfo(session)
        })
      }
    }
    return rows
  }

  listSessions(): EmulatorSessionState[] {
    return [...this.sessions.values()]
  }

  clearIfUnchanged(key: string, session: EmulatorSessionState | undefined): void {
    if (session && this.sessions.get(key) === session) {
      this.clearSessionAndWorktrees(key)
    }
  }

  clearSessionAndWorktrees(key: string): void {
    this.sessions.delete(key)
    for (const [worktreeId, activeKey] of this.activeByWorktree.entries()) {
      if (activeKey === key) {
        this.activeByWorktree.delete(worktreeId)
      }
    }
  }

  /** Drop managed records whose device stopped outside Orca; true while any managed device still runs. */
  async pruneGoneManagedSessions(backendForKind: CensusBackendForKind): Promise<boolean> {
    const managed = this.listSessions().filter((session) => session.managed)
    let live = false
    for (const kind of new Set(managed.map((session) => session.backend))) {
      const backend = backendForKind(kind)
      const census = backend?.listRunningDeviceIds?.()
      // A backend without a census, or one that failed or timed out, proves nothing; keep its records.
      const running = census ? await withTimeout(census, DEVICE_LISTING_BUDGET_MS, null) : null
      for (const session of managed.filter((candidate) => candidate.backend === kind)) {
        // A reattach during the census replaced this record; the census predates it.
        const replaced = this.sessions.get(session.deviceUdid) !== session
        if (running === null || replaced || running.includes(session.deviceUdid)) {
          live = live || this.sessions.has(session.deviceUdid)
        } else {
          this.clearSessionAndWorktrees(session.deviceUdid)
          void backend?.stopHelperForDevice(session.deviceUdid).catch(() => {})
        }
      }
    }
    return live
  }

  clear(): void {
    this.sessions.clear()
    this.activeByWorktree.clear()
  }
}

function toSessionInfo(session: EmulatorSessionState): EmulatorSessionInfo {
  return {
    deviceUdid: session.deviceUdid,
    wsUrl: session.wsUrl,
    streamUrl: session.streamUrl,
    axUrl: session.axUrl,
    helperPid: session.pid,
    streamCodec: session.streamCodec,
    backend: session.backend
  }
}
