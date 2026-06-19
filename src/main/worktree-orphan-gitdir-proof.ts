import { type posix, win32 } from 'path'

type PathOps = typeof posix
export type StatPath = (path: string) => Promise<unknown>
export type ReadPath = (path: string) => Promise<unknown>

export async function gitFileProvesOrphanedWorktreeDirectory(args: {
  gitFilePath: string
  worktreePath: string
  repoPath: string
  pathOps: PathOps
  statPath: StatPath
  readPath: ReadPath
}): Promise<boolean> {
  try {
    const gitEntry = await args.statPath(args.gitFilePath)
    if (!isGitFileStat(gitEntry)) {
      return false
    }
    const gitFileContents = readFileResultToText(await args.readPath(args.gitFilePath))
    return gitFileContents
      ? gitFilePointsAtRepoWorktree(
          gitFileContents,
          args.worktreePath,
          args.repoPath,
          args.pathOps,
          args.statPath,
          args.readPath
        )
      : false
  } catch {
    return false
  }
}

function isGitFileStat(stat: unknown): boolean {
  const fileStat =
    stat && typeof stat === 'object' ? (stat as { isFile?: () => boolean; type?: unknown }) : null
  return !!fileStat && (fileStat.isFile?.() === true || fileStat.type === 'file')
}

function readFileResultToText(result: unknown): string | null {
  if (typeof result === 'string') {
    return result
  }
  if (Buffer.isBuffer(result)) {
    return result.toString('utf8')
  }
  if (result instanceof Uint8Array) {
    return Buffer.from(result).toString('utf8')
  }
  if (!result || typeof result !== 'object') {
    return null
  }
  const remoteRead = result as { content?: unknown; isBinary?: unknown }
  if (remoteRead.isBinary === true || typeof remoteRead.content !== 'string') {
    return null
  }
  return remoteRead.content
}

function resolveGitdirPath(gitdirPath: string, basePath: string, pathOps: PathOps): string {
  return pathOps.isAbsolute(gitdirPath)
    ? pathOps.resolve(gitdirPath)
    : pathOps.resolve(basePath, gitdirPath)
}

function areResolvedPathsEqual(leftPath: string, rightPath: string, pathOps: PathOps): boolean {
  const left = pathOps.normalize(pathOps.resolve(leftPath))
  const right = pathOps.normalize(pathOps.resolve(rightPath))
  return pathOps === win32 ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function resolveRepoWorktreesPath(
  repoPath: string,
  pathOps: PathOps,
  statPath: StatPath,
  readPath: ReadPath
): Promise<string | null> {
  const repoGitPath = pathOps.join(repoPath, '.git')
  try {
    const repoGitEntry = await statPath(repoGitPath)
    if (!isGitFileStat(repoGitEntry)) {
      return pathOps.resolve(repoPath, '.git', 'worktrees')
    }
    const repoGitContents = readFileResultToText(await readPath(repoGitPath))
    const repoGitdirPath = repoGitContents ? parseGitdirPath(repoGitContents) : null
    if (!repoGitdirPath) {
      return null
    }
    const resolvedRepoGitdirPath = resolveGitdirPath(repoGitdirPath, repoPath, pathOps)
    const parentPath = pathOps.dirname(resolvedRepoGitdirPath)
    if (
      pathOps.basename(parentPath) === 'worktrees' &&
      (await repoGitdirIsLinkedWorktreeAdminEntry(
        resolvedRepoGitdirPath,
        repoPath,
        pathOps,
        readPath
      ))
    ) {
      return parentPath
    }
    return pathOps.join(resolvedRepoGitdirPath, 'worktrees')
  } catch {
    return null
  }
}

async function repoGitdirIsLinkedWorktreeAdminEntry(
  resolvedRepoGitdirPath: string,
  repoPath: string,
  pathOps: PathOps,
  readPath: ReadPath
): Promise<boolean> {
  const adminGitdirPath = pathOps.join(resolvedRepoGitdirPath, 'gitdir')
  try {
    const adminGitdirContents = readFileResultToText(await readPath(adminGitdirPath))
    const repoGitPath = adminGitdirContents ? parseFirstLinePath(adminGitdirContents) : null
    if (!repoGitPath) {
      return false
    }
    const resolvedRepoGitPath = resolveGitdirPath(repoGitPath, resolvedRepoGitdirPath, pathOps)
    const resolvedExpectedGitPath = pathOps.resolve(repoPath, '.git')
    // Why: a separate git dir can live under a directory named `worktrees`;
    // only the admin backlink proves the repo path is itself a linked worktree.
    return areResolvedPathsEqual(resolvedRepoGitPath, resolvedExpectedGitPath, pathOps)
  } catch {
    return false
  }
}

async function gitFilePointsAtRepoWorktree(
  contents: string,
  worktreePath: string,
  repoPath: string,
  pathOps: PathOps,
  statPath: StatPath,
  readPath: ReadPath
): Promise<boolean> {
  const gitdirPath = parseGitdirPath(contents)
  if (!gitdirPath) {
    return false
  }
  const resolvedGitdirPath = resolveGitdirPath(gitdirPath, worktreePath, pathOps)
  const repoWorktreesPath = await resolveRepoWorktreesPath(repoPath, pathOps, statPath, readPath)
  if (!repoWorktreesPath || !containsPath(repoWorktreesPath, resolvedGitdirPath, pathOps)) {
    return false
  }
  const relativeGitdirPath = pathOps.relative(repoWorktreesPath, resolvedGitdirPath)
  if (relativeGitdirPath === '' || relativeGitdirPath.includes(pathOps.sep)) {
    return false
  }
  return adminGitdirPointsAtCandidate(resolvedGitdirPath, worktreePath, pathOps, statPath, readPath)
}

async function adminGitdirPointsAtCandidate(
  resolvedGitdirPath: string,
  worktreePath: string,
  pathOps: PathOps,
  statPath: StatPath,
  readPath: ReadPath
): Promise<boolean> {
  const adminGitdirPath = pathOps.join(resolvedGitdirPath, 'gitdir')
  try {
    const adminGitdirContents = readFileResultToText(await readPath(adminGitdirPath))
    const candidateGitPath = adminGitdirContents ? parseFirstLinePath(adminGitdirContents) : null
    if (!candidateGitPath) {
      return false
    }
    const resolvedCandidateGitPath = resolveGitdirPath(
      candidateGitPath,
      resolvedGitdirPath,
      pathOps
    )
    const resolvedExpectedGitPath = pathOps.resolve(worktreePath, '.git')
    // Why: copied .git files can target another worktree's admin entry; only
    // Git's back-reference proves that entry still belongs to this candidate.
    return areResolvedPathsEqual(resolvedCandidateGitPath, resolvedExpectedGitPath, pathOps)
  } catch (error) {
    if (!isMissingPathError(error)) {
      return false
    }
    try {
      await statPath(resolvedGitdirPath)
      return false
    } catch (statError) {
      return isMissingPathError(statError)
    }
  }
}

function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath)
  // Why: `..name` is a valid child name; only `..` and `../...` escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathOps.sep}`) &&
      !pathOps.isAbsolute(relativePath))
  )
}

function parseGitdirPath(contents: string): string | null {
  const firstLine = contents.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) {
    return null
  }
  const match = /^gitdir:\s*(.+)$/i.exec(firstLine)
  const gitdirPath = match?.[1]?.trim()
  return gitdirPath || null
}

function parseFirstLinePath(contents: string): string | null {
  const firstLine = contents.split(/\r?\n/, 1)[0]?.trim()
  return firstLine || null
}

function isMissingPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : typeof error === 'string'
          ? error
          : ''
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|cannot find (?:the )?(?:file|path)|(?:file|path) not found/i.test(
    message
  )
}
