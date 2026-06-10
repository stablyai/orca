import type { EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionState } from './emulator-bridge-types'

export class EmulatorSessionRegistry {
  private readonly activeByWorktree = new Map<string, string>()
  private readonly sessions = new Map<string, EmulatorSessionState>()

  registerActive(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean } = {}
  ): void {
    const key = info.deviceUdid
    this.sessions.set(key, {
      deviceUdid: info.deviceUdid,
      wsUrl: info.wsUrl,
      streamUrl: info.streamUrl,
      axUrl: info.axUrl,
      pid: info.helperPid,
      managed: options.managed === true,
      initialized: true
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
    helperPid: session.pid
  }
}
