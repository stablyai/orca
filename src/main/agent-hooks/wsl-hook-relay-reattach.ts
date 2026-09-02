import type { PtySpawnResult } from '../providers/pty-spawn-result'
import { wslHookRelayManager } from './wsl-hook-relay-manager'

type ReattachResult = Pick<PtySpawnResult, 'isReattach' | 'wslDistro'>

export function ensureWslHookRelayForReattach(
  result: ReattachResult,
  connectionId?: string | null,
  ensureForDistro: (distro: string) => void = (distro) =>
    wslHookRelayManager.ensureForDistro(distro)
): void {
  // Why: the current renderer preference can differ from the surviving PTY's proven distro ownership.
  if (connectionId || result.isReattach !== true || typeof result.wslDistro !== 'string') {
    return
  }
  const distro = result.wslDistro.trim()
  if (distro) {
    ensureForDistro(distro)
  }
}
