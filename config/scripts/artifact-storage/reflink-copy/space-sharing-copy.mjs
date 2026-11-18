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
import { join, relative } from 'node:path'
import * as filesystem from 'node:fs/promises'

// macOS -c clones storage; -P preserves relative framework symlinks required by Chromium resource lookup.
export const MACOS_CLONE_ARGS = Object.freeze(['-c', '-R', '-P'])
// GNU -a preserves modes/symlinks; --reflink=always rejects unsupported filesystems instead of silently copying bytes.
export const LINUX_REFLINK_ARGS = Object.freeze(['--reflink=always', '-a'])

// Try COW clone/reflink then hardlinks; shared inodes require caller’s makeTreeReadOnly or writes mutate source.
// Throw if sharing unavailable so caller can install normally without accidental full-copy cost.
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

// Read-only files stop Electron install.js O_TRUNC from rewriting hardlinked cache/worktrees. Keep directories writable for install renames/unlinks.
export function makeTreeReadOnly(targetPath, chmod = chmodSync) {
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = join(targetPath, entry.name)
    if (entry.isDirectory()) {
      makeTreeReadOnly(entryPath, chmod)
    } else if (!entry.isSymbolicLink()) {
      // Clear only write bits: fixed 0555 would strip shared chrome-sandbox setuid across all worktrees.
      const mode = statSync(entryPath, { throwIfNoEntry: false })?.mode
      chmod(entryPath, mode === undefined ? 0o555 : mode & ~0o222)
    }
  }
  chmod(targetPath, 0o755)
}

// Restore owner write bit on private clone/reflink/copy; inherited read-only cache mode otherwise breaks plist/codesign edits. Preserve group/other bits.
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

// Use COW/byte copy, never hardlinks, for mutable trees; restore owner write permission before caller patches them.
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

export async function shareTreeAsync(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const errors = []
  for (const mechanism of getShareMechanisms(platform)) {
    try {
      await (options[mechanism] ?? asyncShareMechanisms[mechanism])(sourcePath, destinationPath)
      return mechanism
    } catch (error) {
      errors.push(error)
      await filesystem.rm(destinationPath, { recursive: true, force: true })
    }
  }
  throw new AggregateError(errors, `Could not share storage for ${destinationPath}`)
}

async function runSharingCopy(program, args) {
  const { runProcess } = await import('@orca/process-host')
  const result = await runProcess({ program, args, timeoutMs: 45_000, terminationBarrier: true })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`${program} could not share source storage`)
  }
}

const asyncShareMechanisms = {
  clone: (source, destination) =>
    runSharingCopy('/bin/cp', [...MACOS_CLONE_ARGS, source, destination]),
  reflink: (source, destination) =>
    runSharingCopy('cp', [...LINUX_REFLINK_ARGS, source, destination]),
  hardlink: async (source, destination) => {
    await walkTreeAsync(source, async (directory, entries) => {
      const target = join(destination, relative(source, directory))
      await filesystem.mkdir(target, { recursive: true })
      return entries.map((entry) => async () => {
        const from = join(directory, entry.name)
        const to = join(target, entry.name)
        if (entry.isSymbolicLink()) {
          await filesystem.symlink(await filesystem.readlink(from), to)
        } else if (!entry.isDirectory()) {
          await filesystem.link(from, to)
        }
      })
    })
  }
}

async function walkTreeAsync(root, visitDirectory) {
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    const entries = await filesystem.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(join(directory, entry.name))
      }
    }
    const operations = await visitDirectory(directory, entries)
    for (let offset = 0; offset < operations.length; offset += 32) {
      const settled = await Promise.allSettled(
        operations.slice(offset, offset + 32).map((run) => run())
      )
      for (const result of settled) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
    }
  }
}

export async function makeTreeReadOnlyAsync(root) {
  await walkTreeAsync(root, (directory, entries) =>
    entries
      .filter((entry) => !entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => async () => {
        const file = join(directory, entry.name)
        await filesystem.chmod(file, (await filesystem.stat(file)).mode & ~0o222)
      })
  )
}
