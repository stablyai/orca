import type { EmulatorBackendKind, EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionState } from './emulator-bridge-types'
import type { EmulatorBackend } from './backends/emulator-backend'
import { withTimeout } from '../../shared/promise-timeout-fallback'

const DEVICE_LISTING_BUDGET_MS = 5_000

export class EmulatorSessionRegistry {
  private readonly activeByWorktree = new Map<string, string>()
  private readonly sessions = new Map<string, EmulatorSessionState>()

  registerActive(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean; backend?: EmulatorBackendKind } = {}
  ): void {
    const key = info.deviceUdid
    this.sessions.set(key, {
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
    })
    this.activeByWorktree.set(worktreeId, key)
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

  toSessionInfo(session: EmulatorSessionState): EmulatorSessionInfo {
    return toSessionInfo(session)
  }

  hasActiveWorktreeForSession(key: string): boolean {
    return [...this.activeByWorktree.values()].some((activeKey) => activeKey === key)
  }

  listSessions(): EmulatorSessionState[] {
    return [...this.sessions.values()]
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
  async pruneGoneManagedSessions(
    backendForKind: (
      kind: EmulatorBackendKind
    ) => Pick<EmulatorBackend, 'listRunningDeviceIds' | 'stopHelperForDevice'> | null
  ): Promise<boolean> {
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
    streamCodec: session.streamCodec
  }
}
