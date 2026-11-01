import type { posix } from 'node:path'
import { isDefinitiveAbsence } from '../shared/definitive-filesystem-absence'
import { resolveGitCommonDirectory } from '../shared/git-common-directory'
import {
  areResolvedPathsEqual,
  canonicalOwnerPathsEqual,
  isDirectWorktreeAdmin
} from './worktree-owner-path-equivalence'

type PathOps = typeof posix
export type StatPath = (path: string) => Promise<unknown>
export type ReadPath = (path: string) => Promise<unknown>

// Only owning-layout discovery follows links; candidate and admin-entry proof do not.
export type WorktreeProofAccess = {
  statPath: StatPath
  layoutStatPath: StatPath
  readPath: ReadPath
  realPath: (path: string) => Promise<string>
}

export async function gitFileProvesOrphanedWorktreeDirectory(args: {
  gitFilePath: string
  worktreePath: string
  repoPath: string
  pathOps: PathOps
  access: WorktreeProofAccess
}): Promise<boolean> {
  try {
    const gitEntry = await args.access.statPath(args.gitFilePath)
    if (!isGitFileStat(gitEntry)) {
      return false
    }
    const gitFileContents = readFileResultToText(await args.access.readPath(args.gitFilePath))
    return gitFileContents
      ? await gitFilePointsAtRepoWorktree(
          gitFileContents,
          args.worktreePath,
          args.repoPath,
          args.pathOps,
          args.access
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

async function readProvenRepoWorktreesPath(
  repoPath: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<string | null> {
  let owningGitDir: string | null = null
  const common = await resolveGitCommonDirectory(
    repoPath,
    {},
    {
      statPath: async (file) => {
        const entry = await access.layoutStatPath(file)
        return {
          isFile: () => isGitFileStat(entry),
          isDirectory: () => {
            if (!entry || typeof entry !== 'object') {
              return false
            }
            return (
              ('isDirectory' in entry &&
                typeof entry.isDirectory === 'function' &&
                entry.isDirectory() === true) ||
              ('type' in entry && entry.type === 'directory')
            )
          }
        }
      },
      readPath: async (file) => {
        try {
          const text = readFileResultToText(await access.readPath(file))
          if (text === null) {
            throw new Error('Cannot read Git metadata')
          }
          return text
        } catch (error) {
          if (isDefinitiveAbsence(error)) {
            return null
          }
          throw error
        }
      },
      join: pathOps.join,
      resolvePath: (base, pointer) => resolveGitdirPath(pointer, base, pathOps),
      parseMarker: (contents) => {
        const marker = parseGitdirPath(contents)
        owningGitDir = marker ? resolveGitdirPath(marker, repoPath, pathOps) : null
        return marker
      },
      isMissing: isDefinitiveAbsence
    }
  )
  if (!common) {
    return null
  }
  const worktrees = pathOps.join(common, 'worktrees')
  if (
    owningGitDir &&
    (await isDirectWorktreeAdmin(owningGitDir, worktrees, pathOps, access)) &&
    !(await repoGitdirIsLinkedWorktreeAdminEntry(owningGitDir, repoPath, pathOps, access))
  ) {
    return null
  }
  return worktrees
}

async function repoGitdirIsLinkedWorktreeAdminEntry(
  resolvedRepoGitdirPath: string,
  repoPath: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<boolean> {
  const adminGitdirPath = pathOps.join(resolvedRepoGitdirPath, 'gitdir')
  try {
    const adminGitdirContents = readFileResultToText(await access.readPath(adminGitdirPath))
    const repoGitPath = adminGitdirContents ? parseFirstLinePath(adminGitdirContents) : null
    if (!repoGitPath) {
      return false
    }
    const resolvedRepoGitPath = resolveGitdirPath(repoGitPath, resolvedRepoGitdirPath, pathOps)
    const resolvedExpectedGitPath = pathOps.resolve(repoPath, '.git')
    // A linked parent must prove its own backlink before supplying this namespace.
    return (
      areResolvedPathsEqual(resolvedRepoGitPath, resolvedExpectedGitPath, pathOps) ||
      (await canonicalOwnerPathsEqual(
        resolvedRepoGitPath,
        resolvedExpectedGitPath,
        pathOps,
        access
      ))
    )
  } catch {
    return false
  }
}

async function gitFilePointsAtRepoWorktree(
  contents: string,
  worktreePath: string,
  repoPath: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<boolean> {
  const gitdirPath = parseGitdirPath(contents)
  if (!gitdirPath) {
    return false
  }
  const resolvedGitdirPath = resolveGitdirPath(gitdirPath, worktreePath, pathOps)
  const repoWorktreesPath = await readProvenRepoWorktreesPath(repoPath, pathOps, access)
  if (
    !repoWorktreesPath ||
    !(await isDirectWorktreeAdmin(resolvedGitdirPath, repoWorktreesPath, pathOps, access))
  ) {
    return false
  }
  return adminGitdirPointsAtCandidate(
    resolvedGitdirPath,
    worktreePath,
    pathOps,
    access.statPath,
    access.readPath
  )
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
    // A copied .git file can name another checkout; verify the admin entry's backlink.
    return areResolvedPathsEqual(resolvedCandidateGitPath, resolvedExpectedGitPath, pathOps)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      return false
    }
    try {
      await statPath(resolvedGitdirPath)
      return false
    } catch (statError) {
      return isDefinitiveAbsence(statError)
    }
  }
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
