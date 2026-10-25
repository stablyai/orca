/**
 * One line per WSL pane the daemon client spawns or reattaches: who asked, and whether a cold
 * restore came with it. Verify runs read it to find a background spawn that started a restored
 * pane before its window showed it (awin verify-10, inactive tab).
 */
import type { SpawnIntent } from '../../shared/host-spawn-admission'

// Caller frames captured where a spawn enters the daemon router, before any await drops them.
const callersBySessionId = new Map<string, string[]>()

/** Records who asked for this session's spawn; the async spawn path keeps no caller frames. */
export function rememberSpawnCaller(sessionId: string | undefined): void {
  if (!sessionId) {
    return
  }
  const frames = (new Error('wsl spawn caller').stack ?? '')
    .split('\n')
    .slice(2, 10)
    .map((frame) => frame.trim())
  callersBySessionId.set(sessionId, frames)
  if (callersBySessionId.size > 64) {
    callersBySessionId.delete(callersBySessionId.keys().next().value ?? '')
  }
}

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
  const caller = callersBySessionId.get(spawn.sessionId) ?? []
  callersBySessionId.delete(spawn.sessionId)
  console.info('[wsl-spawn-origin]', JSON.stringify({ ...spawn, caller }))
}
