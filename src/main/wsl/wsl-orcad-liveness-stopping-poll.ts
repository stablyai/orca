import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { confirmsRunning, EXIT_SETTLE_MS } from './wsl-orcad-liveness-evidence'
import type { Supervised, WslOrcadLivenessDependencies } from './wsl-orcad-liveness-state'

export const WSL_ORCAD_STOPPING_POLL_MS = 1_000
export const WSL_ORCAD_STOPPING_WINDOW_MS = 5_000

/**
 * After a watch or holder exit, a distro the list still names is usually stopping: read only the
 * running list (never boots) until it drops the distro or the window ends, before any exec into
 * it. An exec while it stops is slow to fail and, landing after the stop, boots it (E9).
 */
export async function readRunningWhileDistroMayBeStopping(args: {
  distro: string
  key: string
  exitedAt: number | null
  running: WslRunningDistrosRead
  now: () => number
  schedule: Schedule
  readRunning: WslOrcadLivenessDependencies['readRunning']
  current: () => boolean
}): Promise<WslRunningDistrosRead> {
  let running = args.running
  const deadline = args.now() + WSL_ORCAD_STOPPING_WINDOW_MS
  while (confirmsRunning(running, args.key) && args.now() < deadline) {
    await new Promise<void>((resolve) => args.schedule(WSL_ORCAD_STOPPING_POLL_MS, resolve))
    if (!args.current()) {
      break
    }
    running = await args.readRunning({
      distro: args.distro,
      exitedAt: args.exitedAt,
      probedAfter: args.now()
    })
  }
  return running
}

type Schedule = (delayMs: number, task: () => void) => unknown

/** After an exit: wait out the settle window, re-read the list, then watch it while it still names the distro. */
export async function settleExitedDistroRunning(
  entry: Pick<Supervised, 'distro' | 'key' | 'lastExitMs'>,
  deps: Pick<WslOrcadLivenessDependencies, 'readRunning'>,
  current: () => boolean,
  now: () => number,
  schedule: Schedule
): Promise<WslRunningDistrosRead> {
  await new Promise<void>((resolve) => schedule(EXIT_SETTLE_MS, resolve))
  const settled = await deps.readRunning({ distro: entry.distro, exitedAt: entry.lastExitMs })
  if (!current()) {
    return settled
  }
  return readRunningWhileDistroMayBeStopping({
    distro: entry.distro,
    key: entry.key,
    exitedAt: entry.lastExitMs,
    running: settled,
    now,
    schedule,
    readRunning: deps.readRunning,
    current
  })
}
