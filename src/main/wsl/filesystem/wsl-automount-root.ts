/**
 * Where each WSL project's distro mounts Windows drives (`[automount] root`, `/mnt/` by default),
 * so a worktree link WSL Git wrote as `<root>c/src/app/.git/worktrees/x` maps back to `C:\…`.
 * Read only from a distro confirmed running after any stop settled, never waking a stopped one,
 * and read again after it stops, since `wsl.conf` changes take effect on the next start. A stop and
 * restart between two probes goes unseen, so Orca's own wake also allows one re-read; a restart
 * outside Orca with no wake after it keeps the old root until the next noticed stop or wake.
 */
import { runProcess } from '@orca/process-host'
import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import { buildPosixStdoutFence } from '../../../shared/shell/launch/posix-stdout-fence'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import {
  onWslDistroGateNote,
  wasWslDistroLastSeenRunningSettled
} from '../discovery/wsl-background-distro-gate'
import { resolveWslInteropSpawnCwd } from '../execution/wsl-interop-spawn-directory'
import {
  onConfirmedRunningWslDistros,
  onRunningWslDistrosStopped
} from '../discovery/wsl-running-distro-cache'
import { resolveWslExecutablePath } from '../execution/wsl-executable-path'

export const DEFAULT_WSL_AUTOMOUNT_ROOT = '/mnt/'

const READ_TIMEOUT_MS = 5_000
// Git's first call may be the one that boots the distro, so its read allows for a cold start.
const COLD_READ_TIMEOUT_MS = 60_000
// A wake re-reads at most this often per distro, so terminals opened on a running distro stay free.
export const WSL_AUTOMOUNT_WAKE_REREAD_INTERVAL_MS = 5 * 60_000

export type WslAutomountRootReader = (distro: string) => Promise<string | null>

const roots = new Map<string, string>()
// Read since its last start, the default `/mnt/` too: one guest launch per start, not per probe.
const readSinceStart = new Set<string>()
const readAt = new Map<string, number>()
const pending = new Map<string, Promise<boolean>>()
// Bumped on a stop, so a read still in flight then neither marks the restarted distro read.
const stopCounts = new Map<string, number>()
const changeListeners = new Set<() => void>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** Every root a known WSL project's distro uses, the default always among them. */
export function knownWslAutomountRoots(): string[] {
  return [...new Set([DEFAULT_WSL_AUTOMOUNT_ROOT, ...roots.values()])]
}

/** The root `distro` last reported since it started, `/mnt/` until read. */
export function wslAutomountRootFor(distro: string): string {
  return roots.get(distroKey(distro)) ?? DEFAULT_WSL_AUTOMOUNT_ROOT
}

export function onWslAutomountRootsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function changed(): void {
  for (const listener of changeListeners) {
    listener()
  }
}

// A failed read is not retried for this long, by probes or Git, so a broken distro fails fast.
const FAILED_READ_RETRY_MS = 10_000
const failedAt = new Map<string, number>()

function recentlyFailed(key: string): boolean {
  const failed = failedAt.get(key)
  return failed !== undefined && performance.now() - failed < FAILED_READ_RETRY_MS
}

/** Resolves true when this read was overtaken by a stop, so the restarted distro needs its own read. */
function startRead(distro: string, read: WslAutomountRootReader): Promise<boolean> {
  const key = distroKey(distro)
  const stopCount = stopCounts.get(key) ?? 0
  const reading = read(distro)
    .catch(() => null)
    .then((root) => {
      if ((stopCounts.get(key) ?? 0) !== stopCount) {
        return true
      }
      if (!root) {
        failedAt.set(key, performance.now())
        return false
      }
      failedAt.delete(key)
      readSinceStart.add(key)
      readAt.set(key, performance.now())
      const previous = roots.get(key) ?? DEFAULT_WSL_AUTOMOUNT_ROOT
      if (root !== previous) {
        if (root === DEFAULT_WSL_AUTOMOUNT_ROOT) {
          roots.delete(key)
        } else {
          roots.set(key, root)
        }
        changed()
      }
      return false
    })
    .finally(() => pending.delete(key))
  pending.set(key, reading)
  return reading
}

/**
 * Reads `distro`'s root before its Git output is read back, when not yet read since its start,
 * and rejects when it cannot be read: output under an unknown root cannot map back to a drive.
 * `admit` runs before any read, so background Git never boots a stopped distro to read it.
 */
export function settleWslAutomountRoot(
  distro: string,
  options: {
    signal?: AbortSignal
    admit?: () => Promise<void> | null
    read?: WslAutomountRootReader
  } = {}
): Promise<void> | null {
  const key = distroKey(distro)
  if (readSinceStart.has(key)) {
    return null
  }
  const read = options.read ?? ((name: string) => readWslAutomountRoot(name, COLD_READ_TIMEOUT_MS))
  const readOnce = async (): Promise<boolean> => {
    if (recentlyFailed(key)) {
      return false
    }
    await options.admit?.()
    // Another caller may have read, or failed to, while this one waited for admission.
    if (readSinceStart.has(key) || recentlyFailed(key)) {
      return false
    }
    return waitForPromiseWithSignal(pending.get(key) ?? startRead(distro, read), options.signal)
  }
  return (async () => {
    // One more read when a stop overtook the first: the distro restarted, nothing failed.
    if ((await readOnce()) && !readSinceStart.has(key)) {
      await readOnce()
    }
    if (!readSinceStart.has(key)) {
      throw new Error(
        `Orca couldn't read where WSL distro ${distro} mounts Windows drives. Try again in a moment.`
      )
    }
  })()
}

/**
 * Follows the running-distro probes for the distros `wanted` names (the WSL projects' distros):
 * reads a root on a confirmed start, forgets it on a stop. Returns the unsubscribe.
 */
export function followWslAutomountRoots(
  wanted: () => readonly string[],
  read: WslAutomountRootReader = readWslAutomountRoot
): () => void {
  const stopRunning = onConfirmedRunningWslDistros((running) => {
    const wantedKeys = new Set(wanted().map(distroKey))
    for (const distro of running) {
      const key = distroKey(distro)
      if (
        !wantedKeys.has(key) ||
        readSinceStart.has(key) ||
        pending.has(key) ||
        recentlyFailed(key)
      ) {
        continue
      }
      // A list probed mid-stop still names the distro, and wsl.exe would boot it again. The cache
      // stores this list before notifying, so this judges it; a later settled list reads.
      if (!wasWslDistroLastSeenRunningSettled(distro)) {
        continue
      }
      void startRead(distro, read)
    }
  })
  const stopStopped = onRunningWslDistrosStopped((stopped) => {
    let removed = false
    for (const distro of stopped) {
      const key = distroKey(distro)
      stopCounts.set(key, (stopCounts.get(key) ?? 0) + 1)
      readSinceStart.delete(key)
      readAt.delete(key)
      removed = roots.delete(key) || removed
    }
    if (removed) {
      changed()
    }
  })
  // A wake may have restarted it unseen: the next settled probe reads again, its old root kept until then.
  const stopWoken = onWslDistroGateNote((note) => {
    const key = distroKey(note.distro)
    const lastRead = readAt.get(key)
    if (
      note.kind === 'woken' &&
      readSinceStart.has(key) &&
      lastRead !== undefined &&
      performance.now() - lastRead >= WSL_AUTOMOUNT_WAKE_REREAD_INTERVAL_MS
    ) {
      readSinceStart.delete(key)
    }
  })
  return () => {
    stopRunning()
    stopStopped()
    stopWoken()
  }
}

/** The effective root from the distro itself: `wslpath` applies `wsl.conf` as WSL does. */
export async function readWslAutomountRoot(
  distro: string,
  timeoutMs: number = READ_TIMEOUT_MS
): Promise<string | null> {
  const fence = buildPosixStdoutFence("wslpath -u 'C:\\'", 'WSL')
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', fence.command]),
    env: { ...process.env, WSL_UTF8: '1' },
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs,
    maxOutputBytes: 4_096
  })
  if (result.timedOut || result.code !== 0) {
    return null
  }
  return parseWslAutomountRoot(fence.readStdout(result.stdout))
}

/** A WSL path under one of `roots` as its Windows drive path (`/mnt/c/x` → `C:\\x`); null otherwise. */
export function wslDrivePathUnderRoots(path: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    const drive = path.startsWith(prefix)
      ? /^([a-z])(\/.*)?$/i.exec(path.slice(prefix.length))
      : null
    if (drive) {
      return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`
    }
  }
  return null
}

/** `/mnt/c/` → `/mnt/`; `/c/` → `/`; null for anything else. */
export function parseWslAutomountRoot(drivePath: string | null): string | null {
  const match = drivePath?.trim().match(/^(\/(?:[^\n]*\/)?)[a-zA-Z]\/?$/)
  return match ? match[1] : null
}
