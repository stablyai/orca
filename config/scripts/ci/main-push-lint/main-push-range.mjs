// Pick the commit a main-push lint diffs against, and list what changed between the two trees.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// The extensions oxlint 1.x lints; oxlint can still exclude an explicit path (ignorePatterns, minified files).
const OXLINT_EXTENSION = /\.(?:[jt]sx?|[cm][jt]s|vue|astro|svelte)$/
// ignoreBOM keeps a leading U+FEFF in a name instead of stripping it as a byte-order mark.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER_BYTES })
  return stdout
}

async function gitBuffer(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER_BYTES
  })
  return stdout
}

export function isZeroSha(sha) {
  return /^0+$/.test(sha ?? '')
}

export function isLintable(file) {
  return OXLINT_EXTENSION.test(file)
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

export async function parentsOf(head, cwd) {
  // A shallow commit still records its parents, so a root commit is told apart from an unfetched parent.
  // Headers end at the first blank line; a message line that starts with "parent " is not a header.
  const object = await git(['cat-file', 'commit', head], cwd)
  const end = object.indexOf('\n\n')
  return (end === -1 ? object : object.slice(0, end))
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

// Every path the two trees differ in, deletions included, with Git's exact bytes checked as UTF-8:
// oxlint takes paths as strings, so a path that is not valid UTF-8 cannot be passed on exactly.
export async function changedPaths(base, head, cwd) {
  const output = await gitBuffer(['diff', '--name-status', '-z', '--no-renames', base, head], cwd)
  const fields = []
  let start = 0
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index))
      start = index + 1
    }
  }
  const changes = []
  const unrepresentable = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index].toString('latin1')
    try {
      changes.push({ status, path: STRICT_UTF8.decode(fields[index + 1]) })
    } catch {
      // Show the bytes as written, with each invalid byte as \xNN, so the file can still be found.
      unrepresentable.push({
        status,
        path: [...fields[index + 1]]
          .map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : `\\x${byte.toString(16)}`))
          .join('')
      })
    }
  }
  return { changes, unrepresentable }
}

// Lintable files the push added or modified; deletions have nothing to lint.
export async function changedLintableFiles(base, head, cwd) {
  const { changes } = await changedPaths(base, head, cwd)
  return changes
    .filter((change) => change.status !== 'D' && isLintable(change.path))
    .map((change) => change.path)
}
