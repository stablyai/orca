import type { PtySpawnResult } from '../providers/pty-spawn-result'
import { wslHookRelayManager } from './wsl-hook-relay-manager'

type ReattachResult = Pick<PtySpawnResult, 'isReattach' | 'wslDistro'>

export function ensureWslHookRelayForReattach(
  result: ReattachResult,
  connectionId?: string | null,
  ensureForDistro: (distro: string) => void = (distro) =>
    wslHookRelayManager.ensureForDistro(distro)
): void {
  // Surviving PTY distro ownership overrides the current renderer preference.
  if (connectionId || result.isReattach !== true || typeof result.wslDistro !== 'string') {
    return
  }
  const distro = result.wslDistro.trim()
  if (distro) {
    ensureForDistro(distro)
  }
}
