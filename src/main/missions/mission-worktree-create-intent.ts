import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { GitWorktreeInfo } from '../../shared/types'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import { assertOwnedMissionRoot } from './mission-root'
import {
  readMissionWorktreeOwnershipMarker,
  writeMissionWorktreeOwnershipMarker,
  type MissionWorktreeOwnershipProof
} from './mission-worktree-ownership-marker'

const INTENT_VERSION = 1
const INTENT_FILE_PREFIX = '.orca-mission-worktree-create-'

export type MissionRootOwnership = {
  baseDir: string
  rootPath: string
  missionId: string
}

export type MissionWorktreeCreateIntent = {
  version: 1
  missionId: string
  repoId: string
  branchName: string
  worktreePath: string
  worktreeInstanceId: string
  preserveBranchOnDelete: boolean
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function intentPath(rootPath: string, repoId: string): string {
  const repoKey = createHash('sha256').update(repoId).digest('hex')
  return path.join(rootPath, `${INTENT_FILE_PREFIX}${repoKey}.json`)
}

function pathsMatch(left: string, right: string): boolean {
  return areWorktreePathsEqual(left, right)
}

function fsyncIntentDirectory(filePath: string): void {
  // Why: Node cannot open/fsync directories on Windows; linkSync remains the
  // atomic publish boundary there, while POSIX can durably commit its metadata.
  if (process.platform === 'win32') {
    return
  }
  const directory = openSync(path.dirname(filePath), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function assertIntentIdentity(
  root: MissionRootOwnership,
  intent: MissionWorktreeCreateIntent
): void {
  if (
    intent.version !== INTENT_VERSION ||
    typeof intent.missionId !== 'string' ||
    intent.missionId.length === 0 ||
    intent.missionId !== root.missionId ||
    typeof intent.repoId !== 'string' ||
    intent.repoId.length === 0 ||
    typeof intent.branchName !== 'string' ||
    intent.branchName.length === 0 ||
    typeof intent.worktreeInstanceId !== 'string' ||
    intent.worktreeInstanceId.length === 0 ||
    typeof intent.preserveBranchOnDelete !== 'boolean' ||
    typeof intent.worktreePath !== 'string' ||
    !path.isAbsolute(intent.worktreePath) ||
    path.resolve(intent.worktreePath) !== intent.worktreePath ||
    !pathsMatch(path.dirname(intent.worktreePath), root.rootPath)
  ) {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
}

function parseIntent(
  root: MissionRootOwnership,
  repoId: string,
  serialized: string
): MissionWorktreeCreateIntent {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
  const intent = parsed as MissionWorktreeCreateIntent
  assertIntentIdentity(root, intent)
  if (intent.repoId !== repoId) {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
  return intent
}

function intentMatches(
  current: MissionWorktreeCreateIntent,
  expected: MissionWorktreeCreateIntent
): boolean {
  return (
    current.version === expected.version &&
    current.missionId === expected.missionId &&
    current.repoId === expected.repoId &&
    current.branchName === expected.branchName &&
    pathsMatch(current.worktreePath, expected.worktreePath) &&
    current.worktreeInstanceId === expected.worktreeInstanceId &&
    current.preserveBranchOnDelete === expected.preserveBranchOnDelete
  )
}

export function readMissionWorktreeCreateIntent(
  root: MissionRootOwnership,
  repoId: string
): MissionWorktreeCreateIntent | null {
  assertOwnedMissionRoot(root)
  const filePath = intentPath(root.rootPath, repoId)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(filePath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
  return parseIntent(root, repoId, readFileSync(filePath, 'utf8'))
}

export function writeMissionWorktreeCreateIntent(args: {
  root: MissionRootOwnership
  repoId: string
  branchName: string
  worktreePath: string
  worktreeInstanceId: string
  preserveBranchOnDelete: boolean
}): MissionWorktreeCreateIntent {
  assertOwnedMissionRoot(args.root)
  const intent: MissionWorktreeCreateIntent = {
    version: INTENT_VERSION,
    missionId: args.root.missionId,
    repoId: args.repoId,
    branchName: args.branchName,
    worktreePath: args.worktreePath,
    worktreeInstanceId: args.worktreeInstanceId,
    preserveBranchOnDelete: args.preserveBranchOnDelete
  }
  assertIntentIdentity(args.root, intent)
  const filePath = intentPath(args.root.rootPath, args.repoId)
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, JSON.stringify(intent), { encoding: 'utf8', flag: 'wx' })
    const file = openSync(temporaryPath, 'r')
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    // Why: publish the fully flushed intent without replacing a concurrent or
    // crash-left operation that must be recovered first.
    linkSync(temporaryPath, filePath)
    fsyncIntentDirectory(filePath)
    return intent
  } catch (error) {
    throw new Error('mission_member_worktree_create_intent_write_failed', { cause: error })
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file was never created or was already cleaned up.
    }
  }
}

export function clearMissionWorktreeCreateIntent(args: {
  root: MissionRootOwnership
  intent: MissionWorktreeCreateIntent
}): void {
  const current = readMissionWorktreeCreateIntent(args.root, args.intent.repoId)
  if (!current) {
    return
  }
  if (!intentMatches(current, args.intent)) {
    throw new Error('mission_member_worktree_create_intent_unverified')
  }
  unlinkSync(intentPath(args.root.rootPath, args.intent.repoId))
}

function assertRecoverableWorktree(
  intent: MissionWorktreeCreateIntent,
  worktree: GitWorktreeInfo
): void {
  let targetStat: ReturnType<typeof lstatSync>
  try {
    targetStat = lstatSync(intent.worktreePath)
  } catch (error) {
    throw new Error('mission_member_worktree_create_recovery_unverified', { cause: error })
  }
  if (
    targetStat.isSymbolicLink() ||
    !targetStat.isDirectory() ||
    worktree.isMainWorktree ||
    worktree.isBare ||
    worktree.prunable ||
    worktree.branch.replace(/^refs\/heads\//, '') !== intent.branchName
  ) {
    throw new Error('mission_member_worktree_create_recovery_unverified')
  }
}

/** Convert an add-complete crash intent into the same Git-admin ownership
 * marker that the uninterrupted create path would have published. */
export function recoverMissionWorktreeCreateIntent(args: {
  root: MissionRootOwnership
  repoId: string
  repoPath: string
  branchName: string
  worktrees: GitWorktreeInfo[]
}): MissionWorktreeOwnershipProof | null {
  const intent = readMissionWorktreeCreateIntent(args.root, args.repoId)
  if (!intent) {
    return null
  }
  if (intent.branchName !== args.branchName) {
    throw new Error('mission_member_worktree_create_recovery_unverified')
  }
  const matches = args.worktrees.filter((worktree) =>
    pathsMatch(worktree.path, intent.worktreePath)
  )
  if (matches.length === 0) {
    try {
      lstatSync(intent.worktreePath)
    } catch (error) {
      if (isMissingPathError(error)) {
        clearMissionWorktreeCreateIntent({ root: args.root, intent })
        return null
      }
      throw error
    }
    // An unregistered non-empty/partial path may contain user data; never
    // delete or claim it solely from the intent.
    throw new Error('mission_member_worktree_create_recovery_unverified')
  }
  if (matches.length !== 1) {
    throw new Error('mission_member_worktree_create_recovery_unverified')
  }
  const worktree = matches[0]
  assertRecoverableWorktree(intent, worktree)
  const proof: MissionWorktreeOwnershipProof = {
    missionId: intent.missionId,
    repoId: intent.repoId,
    worktreeId: `${intent.repoId}::${worktree.path}`,
    worktreeInstanceId: intent.worktreeInstanceId,
    ...(intent.preserveBranchOnDelete ? { preserveBranchOnDelete: true } : {})
  }
  const existingMarker = readMissionWorktreeOwnershipMarker({
    repoPath: args.repoPath,
    worktreePath: worktree.path
  })
  if (existingMarker) {
    if (
      existingMarker.missionId !== proof.missionId ||
      existingMarker.repoId !== proof.repoId ||
      existingMarker.worktreeId !== proof.worktreeId ||
      existingMarker.worktreeInstanceId !== proof.worktreeInstanceId ||
      existingMarker.preserveBranchOnDelete !== proof.preserveBranchOnDelete
    ) {
      throw new Error('mission_member_worktree_create_recovery_unverified')
    }
  } else {
    writeMissionWorktreeOwnershipMarker({
      repoPath: args.repoPath,
      worktreePath: worktree.path,
      proof
    })
  }
  // The Git-admin marker now carries every fact needed to reconstruct metadata.
  clearMissionWorktreeCreateIntent({ root: args.root, intent })
  return proof
}
