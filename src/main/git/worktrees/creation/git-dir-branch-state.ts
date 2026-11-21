import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { basename, dirname, join } from 'node:path'

/** A HEAD whose branch the files cannot tell: reftable leaves this placeholder, and odd symlinks map to it. */
export const UNRESOLVED_HEAD = 'ref: refs/heads/.invalid'

export type GitDirState = {
  /** Each git dir's HEAD file, keyed by git dir. */
  heads: ReadonlyMap<string, string>
  /** Branches a rebase (head-name, --update-refs) or bisect reserves: Git's own in-use rule. */
  reserved: ReadonlySet<string>
}

// Reads files only: this runs inside an admitted command, where running Git could wait on its own slot.
export async function readGitDirState(commonDir: string): Promise<GitDirState> {
  // Fail closed: an unreadable common dir must not look like "nothing in use".
  if (!(await stat(commonDir)).isDirectory()) {
    throw new Error(`${commonDir} is not a Git directory`)
  }
  const gitDirs = [commonDir]
  try {
    for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        gitDirs.push(join(commonDir, 'worktrees', entry.name))
      }
    }
  } catch (error) {
    rethrowUnlessMissing(error)
  }
  const heads = new Map<string, string>()
  const reserved = new Set<string>()
  await Promise.all(
    gitDirs.map(async (gitDir) => {
      const [head, rebaseMerge, rebaseApply, updateRefs, bisectStart] = await Promise.all([
        readHead(gitDir),
        readOptional(join(gitDir, 'rebase-merge', 'head-name')),
        readOptional(join(gitDir, 'rebase-apply', 'head-name')),
        readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
        readOptional(join(gitDir, 'BISECT_START'))
      ])
      heads.set(gitDir, head)
      for (const line of [rebaseMerge, rebaseApply, updateRefs].flatMap((text) =>
        text.split('\n')
      )) {
        if (line.startsWith('refs/heads/')) {
          reserved.add(line.trim())
        }
      }
      const bisected = bisectStart.trim()
      if (bisected) {
        reserved.add(bisected.startsWith('refs/') ? bisected : `refs/heads/${bisected}`)
      }
    })
  )
  return { heads, reserved }
}

// Git accepts a symlinked HEAD: read its content, else name the ref it links to.
async function readHead(gitDir: string): Promise<string> {
  const path = join(gitDir, 'HEAD')
  const content = (await readOptional(path)).trim()
  // Only a HEAD without a `ref:` line can be a symlink that names a branch.
  if (content.startsWith('ref: ')) {
    return content
  }
  let target: string
  try {
    target = await readlink(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EINVAL' || code === 'UNKNOWN') {
      return content
    }
    rethrowUnlessMissing(error)
    return ''
  }
  return target.startsWith('refs/') ? `ref: ${target}` : UNRESOLVED_HEAD
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function rethrowUnlessMissing(error: unknown): void {
  const code = errorCode(error)
  if (code !== 'ENOENT' && code !== 'ENOTDIR') {
    throw error
  }
}

/** Same file system entry after resolving symlinks; false when either is missing. */
export async function isSamePath(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)])
    return normalizeRuntimePathForComparison(a) === normalizeRuntimePathForComparison(b)
  } catch {
    return false
  }
}

/** Git reports a bare repo's own HEAD as the repo, minus any `/.git`; it checks nothing out. */
export async function locateRepoOwnHead(
  ownerPath: string,
  commonDir: string
): Promise<{ isCommonDir: boolean; isRepoItself: boolean }> {
  if (!ownerPath) {
    return { isCommonDir: false, isRepoItself: false }
  }
  const realCommonDir = await realpath(commonDir).catch(() => commonDir)
  const isCommonDir = await isSamePath(ownerPath, realCommonDir)
  const isRepoItself =
    isCommonDir ||
    (basename(realCommonDir) === '.git' && (await isSamePath(ownerPath, dirname(realCommonDir))))
  return { isCommonDir, isRepoItself }
}

/** Git dirs whose HEAD names the branch, skipping a bare common dir's own HEAD. */
export function countBranchCheckouts(
  heads: GitDirState['heads'],
  fullRef: string,
  bareCommonDir: string | undefined
): number {
  return [...heads].filter(
    ([gitDir, head]) => head === `ref: ${fullRef}` && gitDir !== bareCommonDir
  ).length
}

/** Reads `for-each-ref --format=%(refname)%00%(worktreepath)%00` output; the pattern also matches refs under `<fullRef>/`. */
export function parseWorktreePathOfRef(stdout: string, fullRef: string): string {
  // Ref names hold no newline or NUL; paths hold no NUL.
  const text = `\n${stdout}`
  const at = text.indexOf(`\n${fullRef}\0`)
  if (at === -1) {
    return ''
  }
  const from = at + fullRef.length + 2
  return text.slice(from, text.indexOf('\0', from))
}

/** Git's in-use rule from files: a rebase/bisect reservation or a HEAD naming the branch; fails closed on a HEAD the files cannot resolve. */
export function isBranchInUse(
  { heads, reserved }: GitDirState,
  fullRef: string,
  bareCommonDir: string | undefined
): boolean {
  return (
    reserved.has(fullRef) ||
    [...heads].some(
      ([gitDir, head]) =>
        gitDir !== bareCommonDir && (head === `ref: ${fullRef}` || head === UNRESOLVED_HEAD)
    )
  )
}
