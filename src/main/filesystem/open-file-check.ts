import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

// Past these the answer is "can't tell": a slow check must not hold a launch.
const LSOF_TIMEOUT_MS = 5_000
const LSOF_ARGS_BYTES = 256 * 1024
const PROC_SCAN_BUDGET_MS = 5_000
// libuv opens with no sharing under this flag, which Windows refuses while any handle is open.
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000

type Target = { path: string; ino: bigint; dev: bigint }

// Every readable process's open files, from the /proc fd links: reading a link never touches the
// file's own filesystem, so a dead network mount can't stall it. Processes Orca can't read are
// skipped, and so are other users' (their descriptors are unreadable anyway).
async function openOnLinux(
  targets: Target[],
  firstOnly: boolean,
  shouldStop: () => boolean
): Promise<Set<string> | null> {
  const paths = new Set(targets.map((target) => target.path))
  const byInode = new Map(targets.map((target) => [`${target.dev}:${target.ino}`, target.path]))
  const found = new Set<string>()
  const deadline = Date.now() + PROC_SCAN_BUDGET_MS
  const uid = process.getuid?.()
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) {
      continue
    }
    const owner = await stat(join('/proc', pid)).catch(() => null)
    if (!owner || (uid !== undefined && owner.uid !== uid)) {
      continue
    }
    const fds = await readdir(join('/proc', pid, 'fd')).catch(() => [])
    for (const fd of fds) {
      // Checked per descriptor: one process can hold tens of thousands.
      if (Date.now() > deadline || shouldStop()) {
        return null
      }
      const link = join('/proc', pid, 'fd', fd)
      const path = await readlink(link).catch(() => null)
      // A file moved by hard link keeps the descriptor under its old, unlinked name: only those
      // are matched by inode, so the scan still never touches other files' filesystems.
      const match =
        path && paths.has(path)
          ? path
          : path?.endsWith(' (deleted)')
            ? await stat(link, { bigint: true }).then(
                (file) => byInode.get(`${file.dev}:${file.ino}`),
                () => undefined
              )
            : undefined
      if (match) {
        found.add(match)
        if (firstOnly || found.size === paths.size) {
          return found
        }
      }
    }
  }
  return found
}

// Matched by inode: lsof escapes unusual characters in the names it prints. It exits 0 when every
// file is open, 1 with output when some are, and 1 with no output when none are; an exit 1 that
// complains on stderr failed. Processes of other users are invisible to it.
async function openOnMac(targets: Target[]): Promise<Set<string> | null> {
  // Batched well under ARG_MAX (1 MiB on macOS), so a long list never fails to start.
  const found = new Set<string>()
  let batch: Target[] = []
  let bytes = 0
  for (const target of [...targets, null]) {
    if (target === null || (batch.length > 0 && bytes + target.path.length > LSOF_ARGS_BYTES)) {
      const open = await openOnMacBatch(batch)
      if (!open) {
        return null
      }
      open.forEach((path) => found.add(path))
      batch = []
      bytes = 0
    }
    if (target !== null) {
      batch.push(target)
      bytes += target.path.length + 1
    }
  }
  return found
}

async function openOnMacBatch(targets: Target[]): Promise<Set<string> | null> {
  if (targets.length === 0) {
    return new Set()
  }
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
        targets.push({ path, ino: stats.ino, dev: stats.dev })
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
  firstOnly: boolean,
  shouldStop: () => boolean
): (targets: Target[]) => Promise<Set<string> | null> {
  return process.platform === 'win32'
    ? openOnWindows
    : process.platform === 'linux'
      ? (targets) => openOnLinux(targets, firstOnly, shouldStop)
      : openOnMac
}

/**
 * Which of `files` some process has open; null when that can't be told or `shouldStop` turns true.
 * `firstOnly` stops at the first one found.
 */
export function findOpenFiles(
  files: string[],
  options: { firstOnly?: boolean; shouldStop?: () => boolean } = {}
): Promise<Set<string> | null> {
  return findFiles(
    files,
    openOnThisPlatform(options.firstOnly ?? false, options.shouldStop ?? (() => false))
  )
}
