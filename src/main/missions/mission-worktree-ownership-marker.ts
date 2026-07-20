import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

const MARKER_NAME = 'orca-mission-owner.json'
const MARKER_VERSION = 1

export type MissionWorktreeOwnershipProof = {
  missionId: string
  repoId: string
  worktreeId: string
  worktreeInstanceId: string
  /** Durable deletion policy for a branch that predated Mission creation. */
  preserveBranchOnDelete?: true
}

type MissionWorktreeOwnershipMarker = {
  version: 1
  missionId: string
  repoId: string
  worktreeId: string
  instanceId: string
  preserveBranchOnDelete?: true
}

function resolveGitDir(worktreePath: string): string {
  const dotGitPath = path.join(worktreePath, '.git')
  const dotGitStat = lstatSync(dotGitPath)
  if (dotGitStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  if (dotGitStat.isDirectory()) {
    return realpathSync(dotGitPath)
  }
  if (!dotGitStat.isFile()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  const match = readFileSync(dotGitPath, 'utf8').match(/^gitdir:\s*(.+?)\s*$/)
  if (!match) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  return realpathSync(path.resolve(worktreePath, match[1]))
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function resolveCommonGitDirFromGitDir(gitDir: string): string {
  const commondirPath = path.join(gitDir, 'commondir')
  let commondirStat: ReturnType<typeof lstatSync>
  try {
    commondirStat = lstatSync(commondirPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return gitDir
    }
    throw error
  }
  if (!commondirStat.isFile() || commondirStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  const commondir = readFileSync(commondirPath, 'utf8').trim()
  if (!commondir || /[\r\n]/.test(commondir)) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  const commonGitDir = realpathSync(path.resolve(gitDir, commondir))
  const commonGitDirStat = lstatSync(commonGitDir)
  if (!commonGitDirStat.isDirectory() || commonGitDirStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  return commonGitDir
}

function resolveRepoCommonGitDir(repoPath: string, targetCommonGitDir: string): string {
  try {
    const commonGitDir = resolveCommonGitDirFromGitDir(resolveGitDir(repoPath))
    if (!pathsReferToSameLocation(commonGitDir, targetCommonGitDir)) {
      throw new Error('mission_member_worktree_gitdir_untrusted')
    }
    return commonGitDir
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }

  // Why: a bare repository has no `<repo>/.git`; the linked checkout's
  // commondir must identify the registered bare root exactly.
  const bareGitDir = resolveTrustedDirectory(repoPath)
  if (!pathsReferToSameLocation(bareGitDir, targetCommonGitDir)) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  return bareGitDir
}

function resolveTrustedDirectory(directoryPath: string): string {
  const directoryStat = lstatSync(directoryPath)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  return realpathSync(directoryPath)
}

function pathsReferToSameLocation(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function resolveMarkerPath(repoPath: string, worktreePath: string): string {
  const worktreeGitDir = resolveGitDir(worktreePath)
  const commonGitDir = resolveCommonGitDirFromGitDir(worktreeGitDir)
  // Why: repoPath may be a main checkout, sibling linked checkout, or bare
  // repository, but it must resolve to this target checkout's common Git dir.
  resolveRepoCommonGitDir(repoPath, commonGitDir)
  const worktreesDir = resolveTrustedDirectory(path.join(commonGitDir, 'worktrees'))
  // Why: native Windows Git may vary drive/path casing and slash spelling
  // while referring to the same canonical worktrees directory.
  if (!pathsReferToSameLocation(path.dirname(worktreeGitDir), worktreesDir)) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  const gitDirStat = lstatSync(worktreeGitDir)
  if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_gitdir_untrusted')
  }
  return path.join(worktreeGitDir, MARKER_NAME)
}

function readMarker(markerPath: string): MissionWorktreeOwnershipMarker {
  const markerStat = lstatSync(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_ownership_unverified')
  }
  const parsed = JSON.parse(
    readFileSync(markerPath, 'utf8')
  ) as Partial<MissionWorktreeOwnershipMarker>
  if (
    parsed.version !== MARKER_VERSION ||
    typeof parsed.missionId !== 'string' ||
    parsed.missionId.length === 0 ||
    typeof parsed.repoId !== 'string' ||
    parsed.repoId.length === 0 ||
    typeof parsed.worktreeId !== 'string' ||
    parsed.worktreeId.length === 0 ||
    typeof parsed.instanceId !== 'string' ||
    parsed.instanceId.length === 0 ||
    (parsed.preserveBranchOnDelete !== undefined && parsed.preserveBranchOnDelete !== true)
  ) {
    throw new Error('mission_member_worktree_ownership_unverified')
  }
  return parsed as MissionWorktreeOwnershipMarker
}

function markerMatches(
  marker: MissionWorktreeOwnershipMarker,
  proof: MissionWorktreeOwnershipProof
): boolean {
  return (
    marker.missionId === proof.missionId &&
    marker.repoId === proof.repoId &&
    marker.worktreeId === proof.worktreeId &&
    marker.instanceId === proof.worktreeInstanceId
  )
}

export function readMissionWorktreeOwnershipMarker(args: {
  repoPath: string
  worktreePath: string
}): MissionWorktreeOwnershipProof | null {
  try {
    // Check absence at the target admin dir before requiring a live common-dir
    // relationship; pruned legacy orphans legitimately retain a stale .git file.
    const candidateMarkerPath = path.join(resolveGitDir(args.worktreePath), MARKER_NAME)
    try {
      lstatSync(candidateMarkerPath)
    } catch (error) {
      if (isMissingPathError(error)) {
        return null
      }
      throw error
    }
    const marker = readMarker(resolveMarkerPath(args.repoPath, args.worktreePath))
    return {
      missionId: marker.missionId,
      repoId: marker.repoId,
      worktreeId: marker.worktreeId,
      worktreeInstanceId: marker.instanceId,
      ...(marker.preserveBranchOnDelete ? { preserveBranchOnDelete: true } : {})
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    if (
      error instanceof Error &&
      error.message === 'mission_member_worktree_ownership_unverified'
    ) {
      throw error
    }
    throw new Error('mission_member_worktree_ownership_unverified', { cause: error })
  }
}

export function writeMissionWorktreeOwnershipMarker(args: {
  repoPath: string
  worktreePath: string
  proof: MissionWorktreeOwnershipProof
}): void {
  const markerPath = resolveMarkerPath(args.repoPath, args.worktreePath)
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${randomUUID()}`
  const marker: MissionWorktreeOwnershipMarker = {
    version: MARKER_VERSION,
    missionId: args.proof.missionId,
    repoId: args.proof.repoId,
    worktreeId: args.proof.worktreeId,
    instanceId: args.proof.worktreeInstanceId,
    ...(args.proof.preserveBranchOnDelete ? { preserveBranchOnDelete: true } : {})
  }
  try {
    writeFileSync(temporaryPath, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' })
    // Why: linking publishes only the fully written file and refuses to replace
    // an ownership marker installed by another operation.
    linkSync(temporaryPath, markerPath)
  } catch (error) {
    throw new Error('mission_member_worktree_marker_write_failed', { cause: error })
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file was never created or was already cleaned up.
    }
  }
}

export function assertMissionWorktreeOwnershipMarker(args: {
  repoPath: string
  worktreePath: string
  proof: MissionWorktreeOwnershipProof
}): void {
  const marker = readMissionWorktreeOwnershipMarker(args)
  if (
    !marker ||
    !markerMatches(
      {
        version: MARKER_VERSION,
        missionId: marker.missionId,
        repoId: marker.repoId,
        worktreeId: marker.worktreeId,
        instanceId: marker.worktreeInstanceId
      },
      args.proof
    )
  ) {
    throw new Error('mission_member_worktree_ownership_unverified')
  }
}

export function hasMissionWorktreeOwnershipMarker(args: {
  repoPath: string
  worktreePath: string
  proof: MissionWorktreeOwnershipProof
}): boolean {
  try {
    assertMissionWorktreeOwnershipMarker(args)
    return true
  } catch {
    return false
  }
}

export function removeMissionWorktreeOwnershipMarker(args: {
  repoPath: string
  worktreePath: string
  proof: MissionWorktreeOwnershipProof
}): void {
  assertMissionWorktreeOwnershipMarker(args)
  unlinkSync(resolveMarkerPath(args.repoPath, args.worktreePath))
}
