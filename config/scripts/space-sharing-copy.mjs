import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { join } from 'node:path'

// -c asks for clonefile(2). -P keeps Electron.framework's relative symlinks as symlinks; resolving
// them breaks Chromium's bundle lookup.
export const MACOS_CLONE_ARGS = Object.freeze(['-c', '-R', '-P'])
// -a implies -d (no symlink following) and preserves mode. --reflink=always fails loudly on a
// filesystem without reflinks rather than silently writing a second full copy.
export const LINUX_REFLINK_ARGS = Object.freeze(['--reflink=always', '-a'])

/**
 * Copy a directory tree so the destination costs no new storage.
 *
 * Three mechanisms, strongest isolation first. Clone and reflink are copy-on-write, so the
 * destination is genuinely private. Hardlinks are not: the two trees share inodes, and a write
 * through either mutates both. That is only sound for a tree nothing writes to, which is why
 * `makeTreeReadOnly` exists and why the caller must apply it.
 *
 * Throws when no mechanism is available, so a caller can fall back to installing normally rather
 * than silently paying for a second full copy.
 */
export function shareTree(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const errors = []
  for (const mechanism of getShareMechanisms(platform)) {
    try {
      ;(options[mechanism] ?? shareMechanisms[mechanism])(sourcePath, destinationPath)
      return mechanism
    } catch (error) {
      errors.push(error)
      // A mechanism can fail part-way through a tree; the next one needs a clean destination.
      rmSync(destinationPath, { recursive: true, force: true })
    }
  }
  throw new AggregateError(errors, `Could not share storage for ${destinationPath}`)
}

function getShareMechanisms(platform) {
  switch (platform) {
    case 'darwin':
      // APFS only. HFS+ has no clonefile, and hardlinking a 585-entry bundle buys little.
      return ['clone']
    case 'linux':
      // reflink covers btrfs/XFS/bcachefs/ZFS; ext4 has none, which is most developers.
      return ['reflink', 'hardlink']
    case 'win32':
      // Block cloning is ReFS-only, so NTFS gets hardlinks or nothing.
      return ['hardlink']
    default:
      return []
  }
}

const shareMechanisms = {
  clone: (sourcePath, destinationPath) =>
    execFileSync('/bin/cp', [...MACOS_CLONE_ARGS, sourcePath, destinationPath], {
      stdio: 'ignore'
    }),
  reflink: (sourcePath, destinationPath) =>
    execFileSync('cp', [...LINUX_REFLINK_ARGS, sourcePath, destinationPath], { stdio: 'ignore' }),
  hardlink: hardlinkTree
}

export function hardlinkTree(sourcePath, destinationPath) {
  mkdirSync(destinationPath, { recursive: true })
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    const from = join(sourcePath, entry.name)
    const to = join(destinationPath, entry.name)
    if (entry.isDirectory()) {
      hardlinkTree(from, to)
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to)
    } else {
      linkSync(from, to)
    }
  }
}

/**
 * Drop write permission across a tree.
 *
 * This is what makes hardlink sharing safe: Electron's own install.js extracts over an existing
 * dist with O_TRUNC, which through a hardlink would rewrite every sibling worktree and the cache at
 * once. Read-only turns that into EPERM. Directories stay writable because unlink needs a writable
 * parent, not a writable file, so the install transaction's renames still work.
 */
export function makeTreeReadOnly(targetPath, chmod = chmodSync) {
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = join(targetPath, entry.name)
    if (entry.isDirectory()) {
      makeTreeReadOnly(entryPath, chmod)
    } else if (!entry.isSymbolicLink()) {
      // Clear the write bits and nothing else. A flat 0o555 would strip setuid from
      // chrome-sandbox, and under hardlink sharing it would strip it in every worktree at once.
      const mode = statSync(entryPath, { throwIfNoEntry: false })?.mode
      chmod(entryPath, mode === undefined ? 0o555 : mode & ~0o222)
    }
  }
  chmod(targetPath, 0o755)
}

/**
 * Restore owner write permission across a private copy.
 *
 * Counterpart to `makeTreeReadOnly`: clonefile, reflink and `cpSync` all carry the source's mode
 * across, so a tree copied from the write-protected shared cache lands read-only and every patch
 * the caller then makes -- `plutil -replace`, `codesign` -- fails with EACCES. Only the owner bit
 * comes back; group and other stay as the source left them.
 */
export function makeTreeWritable(targetPath, chmod = chmodSync) {
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = join(targetPath, entry.name)
    if (entry.isDirectory()) {
      makeTreeWritable(entryPath, chmod)
    } else if (!entry.isSymbolicLink()) {
      const mode = statSync(entryPath, { throwIfNoEntry: false })?.mode
      chmod(entryPath, mode === undefined ? 0o644 : mode | 0o200)
    }
  }
  chmod(targetPath, 0o755)
}

/**
 * Share storage when possible, otherwise copy the bytes.
 *
 * Never hardlinks: this is for trees the caller goes on to patch, where shared inodes would write
 * through into the source. The copy is unprotected on the way out for the same reason -- a private
 * tree the caller cannot write to is useless to it.
 */
export function copyPrivateTree(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const copy = options.copy ?? copyTreeVerbatim
  const unprotect = options.unprotect ?? makeTreeWritable
  const privateMechanisms = new Set(['clone', 'reflink'])
  let result = { mechanism: null, copyError: null }
  if (getShareMechanisms(platform).some((mechanism) => privateMechanisms.has(mechanism))) {
    try {
      result = {
        mechanism: shareTree(sourcePath, destinationPath, {
          ...options,
          hardlink: () => {
            throw new Error('hardlinks would not be private')
          }
        }),
        copyError: null
      }
    } catch (copyError) {
      copy(sourcePath, destinationPath)
      result = { mechanism: null, copyError }
    }
  } else {
    copy(sourcePath, destinationPath)
  }
  unprotect(destinationPath)
  return result
}

function copyTreeVerbatim(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true
  })
}
