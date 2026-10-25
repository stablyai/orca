/**
 * One line per WSL pane the daemon client spawns or reattaches: who asked, and whether a cold
 * restore came with it. Verify runs read it to find a background spawn that started a restored
 * pane before its window showed it (awin verify-10, inactive tab).
 */
import type { SpawnIntent } from '../../shared/host-spawn-admission'

// Caller frames captured where a spawn enters the daemon client, before any await drops them.
const callersBySessionId = new Map<string, string[]>()
const CALLER_FRAME_LIMIT = 40

/** Records who asked for this session's spawn; the async spawn path keeps no caller frames. */
export function rememberSpawnCaller(sessionId: string): void {
  // Why raised: the default 10 frames end inside IPC plumbing, before the async caller frames.
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = CALLER_FRAME_LIMIT
  const stack = new Error('wsl spawn caller').stack ?? ''
  Error.stackTraceLimit = limit
  const frames = stack
    .split('\n')
    .slice(2)
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
  /** Seed shape: verify-13's `$ $` needs to know whether the fresh-shell blanking reached the daemon. */
  seed?: { segments: number; rows: number | undefined; tail: string; seeded: boolean | undefined }
}): void {
  if (!spawn.wslDistro) {
    return
  }
  const caller = callersBySessionId.get(spawn.sessionId) ?? []
  callersBySessionId.delete(spawn.sessionId)
  console.info('[wsl-spawn-origin]', JSON.stringify({ ...spawn, caller }))
}

const COLD_RESTORE_SCREEN_PROBE_MS = 3_000

/** After the new shell's first prompt, log what the daemon's own screen holds for a WSL cold restore. */
export function probeWslColdRestoreScreen(
  sessionId: string,
  readSnapshot: () => Promise<
    { snapshotAnsi: string; scrollbackLines: number; rows: number; cols: number } | null | undefined
  >
): void {
  const timer = setTimeout(() => {
    void readSnapshot()
      .then((snapshot) => {
        console.info(
          '[wsl-cold-restore-screen]',
          JSON.stringify({
            sessionId,
            rows: snapshot?.rows,
            cols: snapshot?.cols,
            scrollbackLines: snapshot?.scrollbackLines,
            tail: JSON.stringify(snapshot?.snapshotAnsi.slice(-400) ?? null)
          })
        )
      })
      .catch(() => {})
  }, COLD_RESTORE_SCREEN_PROBE_MS)
  timer.unref?.()
}
