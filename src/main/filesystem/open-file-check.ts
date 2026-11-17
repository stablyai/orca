import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

// Past these the answer is "can't tell": a slow check must not hold a launch.
const LSOF_TIMEOUT_MS = 5_000
const PROC_SCAN_BUDGET_MS = 5_000
// libuv opens with no sharing under this flag, which Windows refuses while any handle is open.
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000

type Target = { path: string; ino: bigint }

// Every readable process's open files, from the /proc fd links: reading a link never touches the
// file's own filesystem, so a dead network mount can't stall it. Processes Orca can't read are
// skipped.
async function openOnLinux(targets: Target[], firstOnly: boolean): Promise<Set<string> | null> {
  const paths = new Set(targets.map((target) => target.path))
  const found = new Set<string>()
  const deadline = Date.now() + PROC_SCAN_BUDGET_MS
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) {
      continue
    }
    const fds = await readdir(join('/proc', pid, 'fd')).catch(() => [])
    for (const fd of fds) {
      // Checked per descriptor: one process can hold tens of thousands.
      if (Date.now() > deadline) {
        return null
      }
      const path = await readlink(join('/proc', pid, 'fd', fd)).catch(() => null)
      if (path && paths.has(path)) {
        found.add(path)
        if (firstOnly || found.size === paths.size) {
          return found
        }
      }
    }
  }
  return found
}

// The kernel's flock and POSIX locks in Orca's PID namespace, whoever holds them (Codex's
// `File::try_lock` is flock). Matched by inode alone: on btrfs a file's st_dev isn't the device
// /proc/locks prints, and a same-numbered inode elsewhere only reads as locked.
async function lockedOnLinux(targets: Target[]): Promise<Set<string> | null> {
  const table = await readFile('/proc/locks', 'utf8').catch(() => null)
  if (table === null) {
    return null
  }
  const inodes = new Set<bigint>()
  for (const field of table.split(/\s+/)) {
    const match = /^[0-9a-f]+:[0-9a-f]+:(\d+)$/i.exec(field)
    if (match) {
      inodes.add(BigInt(match[1]))
    }
  }
  return new Set(targets.filter((target) => inodes.has(target.ino)).map((target) => target.path))
}

// Matched by inode: lsof escapes unusual characters in the names it prints. It exits 0 when every
// file is open, 1 with output when some are, and 1 with no output when none are; an exit 1 that
// complains on stderr failed. Processes of other users are invisible to it.
async function openOnMac(targets: Target[]): Promise<Set<string> | null> {
  const result = await runProcess({
    program: '/usr/sbin/lsof',
    args: ['-w', '-F', 'i', '--', ...targets.map((target) => target.path)],
    timeoutMs: LSOF_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024
  }).catch(() => null)
  if (!result || result.timedOut || result.outputTruncated) {
    return null
  }
  const inodes = new Set(
    result.stdout
      .split('\n')
      .filter((line) => /^i\d+$/.test(line))
      .map((line) => BigInt(line.slice(1)))
  )
  const found = new Set(
    targets.filter((target) => inodes.has(target.ino)).map((target) => target.path)
  )
  if (result.code === 1 && result.stdout.trim() === '' && result.stderr.trim() === '') {
    return found
  }
  // An answer that names none of the files is unknown.
  return (result.code === 0 || result.code === 1) && found.size > 0 ? found : null
}

// Opening exclusively for an instant: a Codex opening that same file then gets a sharing error
// for that one start.
async function openOnWindows(targets: Target[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const { path } of targets) {
    try {
      await (await open(path, constants.O_RDONLY | WINDOWS_EXCLUSIVE_OPEN)).close()
    } catch (error) {
      if (errnoCodeOrUnknown(error) !== 'ENOENT') {
        found.add(path)
      }
    }
  }
  return found
}

// A file that's gone can't be open; one Orca can't look up makes the answer unknown.
async function resolveTargets(
  files: string[]
): Promise<{ targets: Target[]; original: Map<string, string> } | null> {
  const targets: Target[] = []
  const original = new Map<string, string>()
  for (const file of files) {
    try {
      const path = await realpath(file)
      const stats = await lstat(path, { bigint: true })
      if (stats.isFile()) {
        targets.push({ path, ino: stats.ino })
        original.set(path, file)
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return null
      }
    }
  }
  return { targets, original }
}

async function findFiles(
  files: string[],
  check: (targets: Target[]) => Promise<Set<string> | null>
): Promise<Set<string> | null> {
  const resolved = await resolveTargets(files)
  if (!resolved) {
    return null
  }
  if (resolved.targets.length === 0) {
    return new Set()
  }
  const found = await check(resolved.targets)
  return found && new Set([...found].map((path) => resolved.original.get(path) ?? path))
}

function openOnThisPlatform(
  firstOnly: boolean
): (targets: Target[]) => Promise<Set<string> | null> {
  return process.platform === 'win32'
    ? openOnWindows
    : process.platform === 'linux'
      ? (targets) => openOnLinux(targets, firstOnly)
      : openOnMac
}

/**
 * Which of `files` some process has open; null when that can't be told. `firstOnly` stops at the
 * first one found.
 */
export function findOpenFiles(
  files: string[],
  options: { firstOnly?: boolean } = {}
): Promise<Set<string> | null> {
  return findFiles(files, openOnThisPlatform(options.firstOnly ?? false))
}

/**
 * Which of the lock files `files` some process holds; null when that can't be told. On Linux that
 * is the kernel's lock table, which also sees other users' processes; elsewhere a holder always
 * has its lock file open, so an open file counts as held.
 */
export function findHeldLockFiles(files: string[]): Promise<Set<string> | null> {
  return findFiles(files, process.platform === 'linux' ? lockedOnLinux : openOnThisPlatform(true))
}
