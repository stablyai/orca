import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { parseDaemonPidFile, startTimeMatches } from '../daemon/daemon-health'

/**
 * Relocates a per-version runtime directory out of the app install directory
 * into userData, and reclaims old version dirs no live daemon still pins.
 *
 * Why: the Windows NSIS update installer force-closes every process (and, for
 * the terminal runtime, every native binary loaded from a process) whose image
 * lives under the install directory before replacing files. Copying the runtime
 * to a version-keyed userData dir takes it out of that kill zone so the detached
 * daemon and its PTYs survive updates. Both node-pty's native runtime and the
 * daemon's own Node host share this machinery.
 */
export const RELOCATION_COMPLETE_MARKER = '.relocation-complete'

function copyRuntimeTree(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyRuntimeTree(sourcePath, destPath)
    } else if (entry.isFile() && !/\.pdb$/i.test(entry.name)) {
      copyFileSync(sourcePath, destPath)
    }
  }
}

export type IsDaemonPidAlive = (pid: number, startedAtMs: number | null) => boolean

function isDaemonPidAliveDefault(pid: number, startedAtMs: number | null): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return startTimeMatches(pid, startedAtMs)
}

/**
 * Runtime version dirs still claimed by a live daemon, read from the daemon
 * pid files under `daemonRuntimeDir` (`daemon-v<N>.pid`).
 *
 * Why: a daemon deliberately survives app updates, and it loads its version's
 * relocated runtime (node-pty binaries, and — once relocated — its own Node
 * host) on demand. Each pid file records that `appVersion`, so a live daemon's
 * version dir must never be reclaimed while the process is still running.
 */
export function collectInUseRuntimeVersions(
  daemonRuntimeDir: string,
  isPidAlive: IsDaemonPidAlive = isDaemonPidAliveDefault
): Set<string> {
  const inUse = new Set<string>()
  let entries
  try {
    entries = readdirSync(daemonRuntimeDir, { withFileTypes: true })
  } catch {
    return inUse
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^daemon-v\d+\.pid$/.test(entry.name)) {
      continue
    }
    let parsed
    try {
      parsed = parseDaemonPidFile(readFileSync(join(daemonRuntimeDir, entry.name), 'utf8'))
    } catch {
      continue
    }
    // appVersion null => a pre-relocation daemon that loads from the install
    // dir and thus pins no version dir here.
    if (parsed && parsed.appVersion !== null && isPidAlive(parsed.pid, parsed.startedAtMs)) {
      inUse.add(parsed.appVersion)
    }
  }
  return inUse
}

function removeStaleRuntimeVersions(
  destRoot: string,
  keepVersion: string,
  inUseVersions: ReadonlySet<string>
): void {
  let entries
  try {
    entries = readdirSync(destRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepVersion || inUseVersions.has(entry.name)) {
      continue
    }
    // Why: Windows maps the daemon's binaries with FILE_SHARE_DELETE, so a
    // rename/delete succeeds even while a surviving daemon still needs them —
    // a rename heuristic would delete in-use dirs and strand the daemon. Only
    // dirs no live daemon claims via its pid file are safe to remove.
    try {
      rmSync(join(destRoot, entry.name), { recursive: true, force: true })
    } catch {
      // Still locked or already gone — retry on a future launch.
    }
  }
}

/**
 * Ensures `sourceDir` is copied to `destRoot/version` (once, guarded by a
 * completion marker) and reclaims sibling version dirs no live daemon pins.
 * Returns the version dir, or null on any failure (callers fail open to
 * loading from the install dir — the pre-relocation behavior).
 */
export function ensureRelocatedRuntime(options: {
  sourceDir: string
  destRoot: string
  version: string
  daemonRuntimeDir: string
  isDaemonPidAlive?: IsDaemonPidAlive
}): string | null {
  const { sourceDir, destRoot, version, daemonRuntimeDir, isDaemonPidAlive } = options
  const destDir = join(destRoot, version)
  try {
    // Why: the marker is written only after a full copy, so a crash mid-copy
    // leaves no marker and the next launch redoes the copy from scratch.
    if (!existsSync(join(destDir, RELOCATION_COMPLETE_MARKER))) {
      rmSync(destDir, { recursive: true, force: true })
      copyRuntimeTree(sourceDir, destDir)
      writeFileSync(join(destDir, RELOCATION_COMPLETE_MARKER), '')
    }
    const inUseVersions = collectInUseRuntimeVersions(daemonRuntimeDir, isDaemonPidAlive)
    removeStaleRuntimeVersions(destRoot, version, inUseVersions)
    return destDir
  } catch {
    return null
  }
}
