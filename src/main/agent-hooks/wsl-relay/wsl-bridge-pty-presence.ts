/**
 * Live local WSL (bridge) terminals per distro: the hook relay for a distro idles out only when
 * none remain. Fed by the PTY layer at spawn, reattach and exit.
 */
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'

// A WSL terminal whose distro the spawn didn't report: it counts for every distro, so no relay it
// may be using idles out under it (rare: an older daemon reporting no distro).
const UNNAMED_DISTRO = ''

type PresenceListener = (distro: string) => void

export class WslBridgePtyPresence {
  private readonly distroByPty = new Map<string, string>()
  private readonly listeners = new Set<PresenceListener>()

  /** `distro` null: a WSL terminal the spawn didn't name a distro for. */
  noteLive(ptyId: string, distro: string | null): void {
    const key = distro === null ? UNNAMED_DISTRO : wslHookRelayStateKey(distro)
    if (this.distroByPty.get(ptyId) === key) {
      return
    }
    const previous = this.distroByPty.get(ptyId)
    this.distroByPty.set(ptyId, key)
    if (previous !== undefined) {
      this.notify(previous)
    }
    this.notify(key)
  }

  noteExited(ptyId: string): void {
    const key = this.distroByPty.get(ptyId)
    if (key !== undefined) {
      this.distroByPty.delete(ptyId)
      this.notify(key)
    }
  }

  count(distro: string): number {
    const key = wslHookRelayStateKey(distro)
    let live = 0
    for (const candidate of this.distroByPty.values()) {
      live += candidate === key || candidate === UNNAMED_DISTRO ? 1 : 0
    }
    return live
  }

  /** Called with the distro (state key) whose count changed; '' means every distro's. */
  onChange(listener: PresenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(key: string): void {
    for (const listener of this.listeners) {
      listener(key)
    }
  }
}

export const wslBridgePtyPresence = new WslBridgePtyPresence()
