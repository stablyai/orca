/**
 * Where each WSL project's distro mounts Windows drives (`[automount] root`, `/mnt/` by default),
 * so a worktree link WSL Git wrote as `<root>c/src/app/.git/worktrees/x` maps back to `C:\…`.
 * Read only from a distro confirmed running after any stop settled, never waking a stopped one,
 * and read again after it stops, since `wsl.conf` changes take effect on the next start. A stop and
 * restart between two probes goes unseen, so Orca's own wake also allows one re-read; a restart
 * outside Orca with no wake after it keeps the old root until the next noticed stop or wake.
 */
import { runProcess } from '@orca/process-host'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { buildPosixStdoutFence } from '../../../shared/posix-stdout-fence'
import { buildWslExecArgs } from '../../../shared/wsl-login-shell-command'
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
import { WSL_DISTRO_BOOT_TIMEOUT_MS } from '../discovery/wsl-distro-holder-command'

export const DEFAULT_WSL_AUTOMOUNT_ROOT = '/mnt/'

const READ_TIMEOUT_MS = 5_000
export const ROOT_COMMAND = String.raw`wslpath -u 'C:\'`
// A wake re-reads at most this often per distro, so terminals opened on a running distro stay free.
export const WSL_AUTOMOUNT_WAKE_REREAD_INTERVAL_MS = 5 * 60_000

export type WslAutomountRootReader = (distro: string) => Promise<string | null>

const roots = new Map<string, string>()
// Read since its last start, the default `/mnt/` too: one guest launch per start, not per probe.
const readSinceStart = new Set<string>()
const readAt = new Map<string, number>()
const pending = new Map<string, Promise<string | null>>()
const retryAt = new Map<string, number>()
let stopLifecycle: (() => void) | undefined
let resetGeneration = 0
// Bumped on a stop, so a read still in flight then neither marks the restarted distro read.
const stopCounts = new Map<string, number>()
const changeListeners = new Set<() => void>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export type WslAutomountSnapshot = Readonly<{
  distro: string
  root: string | null
  generation: number
  stopCount: number
}>

export function captureWslAutomountSnapshot(distro: string): WslAutomountSnapshot {
  observeLifecycle()
  return Object.freeze({
    distro,
    root: peekWslAutomountRoot(distro),
    generation: resetGeneration,
    stopCount: stopCounts.get(distroKey(distro)) ?? 0
  })
}

export function isWslAutomountSnapshotCurrent(snapshot: WslAutomountSnapshot): boolean {
  return (
    snapshot.generation === resetGeneration &&
    snapshot.stopCount === (stopCounts.get(distroKey(snapshot.distro)) ?? 0)
  )
}

export function assertWslAutomountSnapshotCurrent(snapshot: WslAutomountSnapshot): void {
  if (!isWslAutomountSnapshotCurrent(snapshot)) {
    throw rootUnavailable(snapshot.distro)
  }
}

/** Completed bytes may learn their own epoch's root, never a restarted distro's root. */
export async function settleWslAutomountSnapshot(
  snapshot: WslAutomountSnapshot,
  signal?: AbortSignal
): Promise<WslAutomountSnapshot> {
  signal?.throwIfAborted()
  if (snapshot.root !== null || !isWslAutomountSnapshotCurrent(snapshot)) {
    return snapshot
  }
  const root = await waitForPromiseWithSignal(
    readRoot(snapshot.distro, readWslAutomountRoot),
    signal
  )
  signal?.throwIfAborted()
  return isWslAutomountSnapshotCurrent(snapshot) ? Object.freeze({ ...snapshot, root }) : snapshot
}

/** Every root a known WSL project's distro uses, the default always among them. */
export function knownWslAutomountRoots(): string[] {
  return [...new Set([DEFAULT_WSL_AUTOMOUNT_ROOT, ...roots.values()])]
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

/** A settled root for execution; discovery may retain an older root during wake revalidation. */
export function peekWslAutomountRoot(distro: string): string | null {
  const key = distroKey(distro)
  return readSinceStart.has(key) ? (roots.get(key) ?? DEFAULT_WSL_AUTOMOUNT_ROOT) : null
}

function invalidate(distro: string): void {
  const key = distroKey(distro)
  stopCounts.set(key, (stopCounts.get(key) ?? 0) + 1)
  readSinceStart.delete(key)
  pending.delete(key)
  readAt.delete(key)
  retryAt.delete(key)
  if (roots.delete(key)) {
    changed()
  }
}

function observeLifecycle(): void {
  if (stopLifecycle) {
    return
  }
  const stopStopped = onRunningWslDistrosStopped((stopped) => stopped.forEach(invalidate))
  const stopNoted = onWslDistroGateNote((note) => {
    if (note.kind === 'stopped') {
      invalidate(note.distro)
      return
    }
    const key = distroKey(note.distro)
    const lastRead = readAt.get(key)
    if (
      readSinceStart.has(key) &&
      lastRead !== undefined &&
      performance.now() - lastRead >= WSL_AUTOMOUNT_WAKE_REREAD_INTERVAL_MS
    ) {
      readSinceStart.delete(key)
      pending.delete(key)
      stopCounts.set(key, (stopCounts.get(key) ?? 0) + 1)
      retryAt.delete(key)
    }
  })
  stopLifecycle = () => {
    stopStopped()
    stopNoted()
  }
}

function readRoot(distro: string, read: WslAutomountRootReader): Promise<string | null> {
  const key = distroKey(distro)
  const known = peekWslAutomountRoot(distro)
  if (known !== null) {
    return Promise.resolve(known)
  }
  const joined = pending.get(key)
  if (joined) {
    return joined
  }
  if ((retryAt.get(key) ?? 0) > performance.now()) {
    return Promise.resolve(null)
  }
  const stopCount = stopCounts.get(key) ?? 0
  const generation = resetGeneration
  const current = (): boolean =>
    generation === resetGeneration && (stopCounts.get(key) ?? 0) === stopCount
  const work = Promise.resolve()
    .then(() => (current() ? read(distro) : null))
    .catch(() => null)
    .then((root) => {
      if (!current()) {
        return null
      }
      if (!root) {
        retryAt.set(key, performance.now() + READ_TIMEOUT_MS)
        return null
      }
      retryAt.delete(key)
      readSinceStart.add(key)
      readAt.set(key, performance.now())
      const previous = roots.get(key) ?? DEFAULT_WSL_AUTOMOUNT_ROOT
      if (root === DEFAULT_WSL_AUTOMOUNT_ROOT) {
        roots.delete(key)
      } else {
        roots.set(key, root)
      }
      if (previous !== root) {
        changed()
      }
      return root
    })
    .finally(() => {
      if (pending.get(key) === work) {
        pending.delete(key)
      }
    })
  pending.set(key, work)
  return work
}

export function rootUnavailable(distro: string): Error {
  return new Error(
    `Orca couldn't read Windows drive paths in WSL distro ${distro}. Try again when the distro is available.`
  )
}

/** Only after the caller's WSL admission: this read may start the selected distro. */
export async function ensureWslAutomountRoot(
  distro: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  observeLifecycle()
  const key = distroKey(distro)
  for (;;) {
    const generation = resetGeneration
    const stopCount = stopCounts.get(key) ?? 0
    const root = await waitForPromiseWithSignal(
      readRoot(distro, (name) => readWslAutomountRoot(name, WSL_DISTRO_BOOT_TIMEOUT_MS)),
      signal
    )
    signal?.throwIfAborted()
    if (generation !== resetGeneration || stopCount !== (stopCounts.get(key) ?? 0)) {
      continue
    }
    if (root === null) {
      throw rootUnavailable(distro)
    }
    return root
  }
}

/** Observe project distros without waking stopped ones; foreground callers share these reads. */
export function followWslAutomountRoots(
  wanted: () => readonly string[],
  read: WslAutomountRootReader = readWslAutomountRoot
): () => void {
  observeLifecycle()
  return onConfirmedRunningWslDistros((running) => {
    const wantedKeys = new Set(wanted().map(distroKey))
    for (const distro of running) {
      const key = distroKey(distro)
      if (
        wantedKeys.has(key) &&
        !readSinceStart.has(key) &&
        !pending.has(key) &&
        wasWslDistroLastSeenRunningSettled(distro)
      ) {
        void readRoot(distro, read)
      }
    }
  })
}

/** The effective root from the distro itself: `wslpath` applies `wsl.conf` as WSL does. */
export async function readWslAutomountRoot(
  distro: string,
  timeoutMs = READ_TIMEOUT_MS
): Promise<string | null> {
  const fence = buildPosixStdoutFence(ROOT_COMMAND, 'WSL')
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
      ? /^([a-z])(\/[\s\S]*)?$/i.exec(path.slice(prefix.length))
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

export function resetWslAutomountRootsForTests(): void {
  stopLifecycle?.()
  stopLifecycle = undefined
  resetGeneration += 1
  retryAt.clear()
  roots.clear()
  readSinceStart.clear()
  readAt.clear()
  pending.clear()
  stopCounts.clear()
  changeListeners.clear()
}
