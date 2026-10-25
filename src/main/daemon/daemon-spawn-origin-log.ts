/**
 * One line per WSL pane the daemon client spawns or reattaches: who asked, and whether a cold
 * restore came with it. Verify runs read it to find a background spawn that started a restored
 * pane before its window showed it (awin verify-10, inactive tab).
 */
import type { SpawnIntent } from '../../shared/host-spawn-admission'

export function logWslSpawnOrigin(spawn: {
  sessionId: string
  wslDistro: string | undefined
  isNew: boolean
  attachOnly: boolean
  spawnIntent: SpawnIntent | undefined
  coldRestore: boolean
}): void {
  if (!spawn.wslDistro) {
    return
  }
  // The frames above the daemon client name the caller; four are enough to tell them apart.
  const caller = (new Error('wsl spawn origin').stack ?? '')
    .split('\n')
    .slice(2)
    .filter((frame) => !/[\\/]daemon[\\/]/.test(frame))
    .slice(0, 4)
    .map((frame) => frame.trim())
  console.info('[wsl-spawn-origin]', JSON.stringify({ ...spawn, caller }))
}
