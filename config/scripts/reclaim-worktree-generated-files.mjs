import { chmod, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runProcess } from '@orca/process-host'
import { localRepositoryWorktrees } from './local-repository-worktrees.mjs'
import { parseReclaimArguments } from './reclaim-worktree-command.mjs'

const OUTPUTS = ['node_modules', 'out', 'dist', 'build']
const PACKAGE_ROOTS = [
  [],
  ['mobile'],
  ['native', '*'],
  ['src', 'packages', '*'],
  ['cloud', 'apps', '*'],
  ['cloud', 'packages', '*']
]

async function info(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

async function descend(root, parts) {
  let path = root
  for (const part of parts) {
    path = join(path, part)
    if (!(await info(path))?.isDirectory()) {
      return null
    }
    if (await info(join(path, '.git'))) {
      return null
    }
  }
  return path
}

async function packageRoots(worktree) {
  const roots = new Set()
  for (const pattern of PACKAGE_ROOTS) {
    const wildcard = pattern.at(-1) === '*'
    const parent = await descend(worktree, wildcard ? pattern.slice(0, -1) : pattern)
    if (!parent) {
      continue
    }
    const paths = wildcard
      ? (await readdir(parent, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => [...pattern.slice(0, -1), entry.name])
      : [pattern]
    for (const parts of paths) {
      const path = await descend(worktree, parts)
      if (path && (await info(join(path, 'package.json')))?.isFile()) {
        roots.add(path)
      }
    }
  }
  return roots
}

async function ignoredAndUntracked(worktree, path) {
  const run = (args) =>
    runProcess({
      program: 'git',
      args: ['-C', worktree, ...args],
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      killOnOutputLimit: true,
      terminationBarrier: true
    })
  const target = relative(worktree, path).split(sep).join('/')
  const tracked = await run(['--literal-pathspecs', 'ls-files', '--cached', '-z', '--', target])
  if (tracked.code !== 0 || tracked.timedOut || tracked.outputTruncated || tracked.stdout) {
    return false
  }
  const ignored = await run(['check-ignore', '-q', '--', `${target}/`])
  return ignored.code === 0 && !ignored.timedOut && !ignored.outputTruncated
}

function contains(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

function sameDirectory(first, second) {
  return second?.isDirectory() && first.dev === second.dev && first.ino === second.ino
}

async function containsNestedRepository(root) {
  const pending = [root]
  while (pending.length) {
    const path = pending.pop()
    if (!(await info(path))?.isDirectory()) {
      return true
    }
    const entries = await readdir(path, { withFileTypes: true })
    const names = new Set(entries.map((entry) => entry.name))
    if (
      names.has('.git') ||
      (names.has('HEAD') && names.has('objects') && (names.has('refs') || names.has('config')))
    ) {
      return true
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(join(path, entry.name))
      }
    }
  }
  return false
}

async function makeDirectoriesWritable(root) {
  const pending = [root]
  while (pending.length) {
    const path = pending.pop()
    const current = await info(path)
    if (!current?.isDirectory()) {
      continue
    }
    // Package files can be hardlinked into a shared store; only change directory permissions.
    if (process.getuid && current.uid === process.getuid() && !(current.mode & 0o200)) {
      await chmod(path, current.mode | 0o200)
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(join(path, entry.name))
      }
    }
  }
}

export async function reclaimWorktreeGeneratedFiles({
  repoRoot = process.cwd(),
  apply = false,
  automatic = false,
  generatedMinAgeDays = 30,
  excludeWorktree,
  report = console.log
} = {}) {
  if (!Number.isFinite(generatedMinAgeDays) || generatedMinAgeDays < 0) {
    throw new Error('--generated-min-age-days requires a non-negative number')
  }
  if (automatic) {
    throw new Error('Generated dependency cleanup is only available in the manual reclaim command')
  }
  const protectedPaths = await Promise.all(
    [repoRoot, process.cwd(), ...(excludeWorktree ? [excludeWorktree] : [])].map((p) => realpath(p))
  )
  const { worktrees } = await localRepositoryWorktrees(repoRoot)
  const cutoff = Date.now() - generatedMinAgeDays * 86_400_000
  const candidates = []
  const result = { entries: 0, protected: 0, failed: 0 }
  for (const root of new Set(worktrees)) {
    if (!(await info(root))?.isDirectory()) {
      continue
    }
    const worktree = await realpath(root)
    if (protectedPaths.some((path) => contains(worktree, path))) {
      continue
    }
    for (const packageRoot of await packageRoots(worktree)) {
      for (const name of OUTPUTS) {
        const path = join(packageRoot, name)
        const original = await info(path)
        if (!original?.isDirectory() || original.mtimeMs > cutoff) {
          continue
        }
        if (await ignoredAndUntracked(worktree, path)) {
          candidates.push({ worktree, path, original })
        }
      }
    }
  }

  async function processCandidate({ worktree, path, original }) {
    try {
      const parts = relative(worktree, path).split(sep)
      if (!(await descend(worktree, parts))) {
        result.protected += 1
        return
      }
      const current = await info(path)
      if (
        !sameDirectory(original, current) ||
        current.mtimeMs > cutoff ||
        !(await ignoredAndUntracked(worktree, path)) ||
        (await containsNestedRepository(path))
      ) {
        result.protected += 1
        return
      }
      if (apply) {
        const parent = await descend(worktree, parts)
        const ready = await info(path)
        if (!parent || !sameDirectory(original, ready) || ready.mtimeMs > cutoff) {
          result.protected += 1
          return
        }
        try {
          await rm(path, { recursive: true, force: true })
        } catch (error) {
          if (
            !['EACCES', 'EPERM'].includes(error.code) ||
            !(await descend(worktree, parts)) ||
            !sameDirectory(original, await info(path))
          ) {
            throw error
          }
          await makeDirectoriesWritable(path)
          await rm(path, { recursive: true, force: true })
        }
      }
      result.entries += 1
      report(`${apply ? 'removed' : 'would remove'} generated directory ${JSON.stringify(path)}`)
    } catch (error) {
      result.failed += 1
      report(`failed to remove ${JSON.stringify(path)}: ${error.message}`)
    }
  }
  // Bound filesystem pressure without serializing hundreds of large dependency installs.
  for (let index = 0; index < candidates.length; index += 4) {
    await Promise.all(candidates.slice(index, index + 4).map(processCandidate))
  }
  report(
    `${apply ? 'Removed' : 'Would remove'} ${result.entries} generated directory(s); ${result.protected} changed; ${result.failed} failed. Shared pnpm stores and source files retained.`
  )
  if (result.failed) {
    throw new Error('Some generated directories could not be removed; see failures above')
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseReclaimArguments(process.argv.slice(2))
  reclaimWorktreeGeneratedFiles(options).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
