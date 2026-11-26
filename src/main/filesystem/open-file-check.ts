import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

// Past these the answer is "can't tell": a slow check must not hold a launch.
const LSOF_TIMEOUT_MS = 5_000
const LSOF_ARGS_BYTES = 256 * 1024
// libuv opens with no sharing under this flag, which Windows refuses while any handle is open.
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000

type Target = { path: string; ino: bigint }

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
  if (result.code === 1 && result.stderr.trim() !== '') {
    return null
  }
  if (result.code === 1 && result.stdout.trim() === '') {
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

// A file that's gone can't be open; one Orca can't look up makes the answer unknown. One with
// another name counts as open unasked: that name may be a live Codex's, which a probe would disturb.
async function resolveTargets(
  files: string[]
): Promise<{ targets: Target[]; original: Map<string, string>; linked: string[] } | null> {
  const targets: Target[] = []
  const original = new Map<string, string>()
  const linked: string[] = []
  for (const file of files) {
    try {
      const path = await realpath(file)
      const stats = await lstat(path, { bigint: true })
      if (stats.isFile() && stats.nlink > 1n) {
        linked.push(file)
      } else if (stats.isFile()) {
        targets.push({ path, ino: stats.ino })
        original.set(path, file)
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return null
      }
    }
  }
  return { targets, original, linked }
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
    return new Set(resolved.linked)
  }
  const found = await check(resolved.targets)
  return (
    found &&
    new Set([...resolved.linked, ...[...found].map((path) => resolved.original.get(path) ?? path)])
  )
}

// Linux can't be told reliably: an undumpable process (Codex is one) hides its descriptors, and
// another PID or mount namespace hides the process itself. So the answer there is always unknown.
function openOnThisPlatform(): (targets: Target[]) => Promise<Set<string> | null> {
  return process.platform === 'win32'
    ? openOnWindows
    : process.platform === 'linux'
      ? async () => null
      : openOnMac
}

/**
 * Which of `files` some process has open, or might through another hard link; null when that can't
 * be told, or when `shouldStop` turned true meanwhile.
 */
export async function findOpenFiles(
  files: string[],
  options: { shouldStop?: () => boolean } = {}
): Promise<Set<string> | null> {
  const open = await findFiles(files, openOnThisPlatform())
  return options.shouldStop?.() ? null : open
}
