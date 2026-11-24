// Pick the commit a main-push lint diffs against, and list the lintable files that changed.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// The extensions oxlint 1.x lints; ignorePatterns in .oxlintrc.json can still skip explicit paths.
const OXLINT_EXTENSION = /\.(?:[jt]sx?|[cm][jt]s|vue|astro|svelte)$/

export async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER_BYTES })
  return stdout
}

export function isZeroSha(sha) {
  return /^0+$/.test(sha ?? '')
}

async function hasCommit(sha, cwd) {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], cwd)
    return true
  } catch {
    return false
  }
}

// The checkout is shallow; fetch the one commit the diff needs, or fail instead of narrowing the range.
async function requireCommit(sha, label, cwd) {
  if (await hasCommit(sha, cwd)) {
    return
  }
  let reason = 'the fetch succeeded but the commit is still missing'
  try {
    await git(['fetch', '--no-tags', '--quiet', '--depth=1', 'origin', sha], cwd)
  } catch (error) {
    reason = (error.stderr || error.message || '').trim().split('\n')[0]
  }
  if (!(await hasCommit(sha, cwd))) {
    throw new Error(`Cannot fetch ${label} ${sha} (${reason}); refusing to narrow the lint range.`)
  }
}

async function parentsOf(head, cwd) {
  // A shallow commit still records its parents, so a root commit is told apart from an unfetched parent.
  return (await git(['cat-file', '-p', head], cwd))
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length))
}

// A push diffs its old tip against its new one, forced or not: a two-tree diff needs no shared history.
// A push that creates the branch lints every file at head. A manual run lints the head commit's own change.
export async function resolveRange({ event, before, head, cwd }) {
  if (event === 'push') {
    if (!before) {
      throw new Error('The push event has no before SHA; refusing to guess the lint range.')
    }
    if (isZeroSha(before)) {
      return {
        base: EMPTY_TREE_SHA,
        scope: 'every file at head, because this push created the branch'
      }
    }
    await requireCommit(before, 'the push base', cwd)
    return { base: before, scope: 'the files this push changed' }
  }
  const [parent] = await parentsOf(head, cwd)
  if (!parent) {
    return { base: EMPTY_TREE_SHA, scope: 'every file in the root commit' }
  }
  await requireCommit(parent, 'the parent of the head commit', cwd)
  return { base: parent, scope: "the head commit's own change (manual run)" }
}

export async function changedLintableFiles(base, head, cwd) {
  // NUL-separated so any byte a path can hold survives; deletions have nothing to lint.
  const output = await git(
    ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', base, head],
    cwd
  )
  return output.split('\0').filter((file) => file && OXLINT_EXTENSION.test(file))
}
