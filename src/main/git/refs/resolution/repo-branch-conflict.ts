import { resolveConfiguredRemoteBranchName } from '../snapshot/branch-ref-snapshot-data'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { isSafeGitRefName } from '../../../../shared/git/status/git-status-upstream-ref'
import { isShowRefNoMatchError } from '../../../../shared/git/refs/git-show-ref-no-match'
import {
  probeAnyExactRef,
  probeAnyExactRefBatched,
  type ExactRefProbeExec,
  type ExactRefProbeExecOptions,
  type ExactRefProbeStdinExec
} from './exact-ref-probe'

export type BranchConflictKind = 'local' | 'remote'
/** Exact-name creates must refuse when a probe could not decide. */
export type StrictBranchConflictKind = BranchConflictKind | 'unknown'

function runGit(
  exec: ExactRefProbeExec,
  args: string[],
  options: ExactRefProbeExecOptions
): Promise<{ stdout: string }> {
  return options.maxBuffer === undefined && options.timeoutMs === undefined
    ? exec(args)
    : exec(args, options)
}

function canQueryRemoteBranchName(branchName: string): boolean {
  // Validate before interpolation to reject glob/control/refspec syntax while allowing slashes.
  return !branchName.startsWith('-') && isSafeGitRefName(`refs/heads/${branchName}`)
}

async function probeLocalBranchRef(
  exec: ExactRefProbeExec,
  ref: string,
  options: ExactRefProbeExecOptions
): Promise<'present' | 'absent' | 'unknown'> {
  try {
    // Quiet absence avoids retrying the WSL probe through a login shell.
    const { stdout } = await runGit(exec, ['rev-parse', '--verify', '--quiet', ref], options)
    return stdout.trim().length > 0 ? 'present' : 'unknown'
  } catch (error) {
    return isShowRefNoMatchError(error) ? 'absent' : 'unknown'
  }
}

async function readRemoteNames(
  exec: ExactRefProbeExec,
  options: ExactRefProbeExecOptions
): Promise<string[] | null> {
  try {
    const { stdout } = await runGit(exec, ['remote'], options)
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return null
  }
}

async function listRemoteNamesViaExec(
  exec: ExactRefProbeExec,
  options: ExactRefProbeExecOptions
): Promise<string[]> {
  return (await readRemoteNames(exec, options)) ?? []
}

async function hasCaseFoldedLocalConflict(
  exec: ExactRefProbeExec,
  ref: string,
  options: ExactRefProbeExecOptions
): Promise<boolean> {
  // Git's case-insensitive patterns miss Unicode aliases accepted by ref filesystems.
  const { stdout } = await runGit(
    exec,
    ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
    options
  )
  const foldedRef = foldGitRefNameCase(ref)
  for (const existingRef of stdout.split(/\r?\n/).filter(Boolean)) {
    if (!existingRef.startsWith('refs/heads/') || !isSafeGitRefName(existingRef)) {
      throw new Error('Cannot verify branch-name case conflicts.')
    }
    if (foldGitRefNameCase(existingRef) === foldedRef) {
      return true
    }
  }
  return false
}

export function foldGitRefNameCase(name: string): string {
  return name.normalize('NFD').toLowerCase().toUpperCase().normalize('NFD')
}

function buildRemoteBranchConflictRefs(
  remoteNames: readonly string[],
  branchName: string,
  allowedBaseRef: string | undefined
): string[] {
  const refs = new Set<string>()
  for (const remoteName of remoteNames) {
    const ref = `refs/remotes/${remoteName}/${branchName}`
    if (!isSafeGitRefName(ref)) {
      continue
    }
    // Matching the checkout base is allowed even when multiple remotes carry the same branch.
    if (
      isAllowedRemoteBaseRef(ref, allowedBaseRef) &&
      resolveConfiguredRemoteBranchName(ref, remoteNames) === branchName
    ) {
      return []
    }
    // Prefer the longest configured remote prefix when names overlap.
    if (
      !isAllowedRemoteBaseRef(ref, allowedBaseRef) &&
      resolveConfiguredRemoteBranchName(ref, remoteNames) === branchName
    ) {
      refs.add(ref)
    }
  }
  return [...refs]
}

/** Batch remote probes; use per-ref lookups only when stdin is unavailable or the batch is undecided. */
async function probeAnyRemoteConflictRef(
  exec: ExactRefProbeExec,
  batchedExec: ExactRefProbeStdinExec | undefined,
  candidateRefs: readonly string[],
  probeOptions: ExactRefProbeExecOptions
): Promise<{ found: boolean; unknown: boolean }> {
  if (batchedExec) {
    const batched = await probeAnyExactRefBatched(batchedExec, candidateRefs, probeOptions)
    if (!batched.unknown) {
      return { found: batched.found, unknown: false }
    }
  }
  return probeAnyExactRef(exec, candidateRefs, probeOptions)
}

/** Run branch-conflict policy through the host that owns Git execution. */
export async function getBranchConflictKindViaExec(
  exec: ExactRefProbeExec,
  branchName: string,
  allowedBaseRef?: string,
  options: ExactRefProbeExecOptions = {},
  batchedExec?: ExactRefProbeStdinExec,
  allowLocalBranch?: () => Promise<boolean>
): Promise<BranchConflictKind | null> {
  if (!canQueryRemoteBranchName(branchName)) {
    return null
  }
  // Preserve host output/deadline limits; smaller implicit caps could hide conflicts.
  const probeOptions: ExactRefProbeExecOptions = options
  const localRef = `refs/heads/${branchName}`
  let presence = await probeLocalBranchRef(exec, localRef, probeOptions)
  if (allowLocalBranch && presence !== 'absent') {
    if (await allowLocalBranch()) {
      return null
    }
    // Adoption can span ref changes; preserve the fresh conflict check after it fails.
    presence = await probeLocalBranchRef(exec, localRef, probeOptions)
  }
  if (presence === 'present') {
    return 'local'
  }
  if (await hasCaseFoldedLocalConflict(exec, localRef, probeOptions)) {
    return 'local'
  }

  try {
    const remoteNames = await listRemoteNamesViaExec(exec, probeOptions)
    const candidateRefs = buildRemoteBranchConflictRefs(remoteNames, branchName, allowedBaseRef)
    if (candidateRefs.length === 0) {
      return null
    }

    const { found: hasRemoteConflict } = await probeAnyRemoteConflictRef(
      exec,
      batchedExec,
      candidateRefs,
      probeOptions
    )

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

/** Same policy as getBranchConflictKindViaExec, but a probe that could not decide is 'unknown', not free.
 * A known conflict still wins over 'unknown'. */
export async function getBranchConflictKindStrictViaExec(
  exec: ExactRefProbeExec,
  branchName: string,
  allowedBaseRef?: string,
  options: ExactRefProbeExecOptions = {},
  batchedExec?: ExactRefProbeStdinExec
): Promise<StrictBranchConflictKind | null> {
  if (!canQueryRemoteBranchName(branchName)) {
    return null
  }
  const localRef = `refs/heads/${branchName}`
  try {
    const presence = await probeLocalBranchRef(exec, localRef, options)
    if (presence === 'present') {
      return 'local'
    }
    let unknown = presence === 'unknown'
    try {
      if (await hasCaseFoldedLocalConflict(exec, localRef, options)) {
        return 'local'
      }
    } catch {
      unknown = true
    }
    const remoteNames = await readRemoteNames(exec, options)
    if (remoteNames === null) {
      return 'unknown'
    }
    const candidateRefs = buildRemoteBranchConflictRefs(remoteNames, branchName, allowedBaseRef)
    if (candidateRefs.length > 0) {
      const remote = await probeAnyRemoteConflictRef(exec, batchedExec, candidateRefs, options)
      if (remote.found) {
        return 'remote'
      }
      unknown ||= remote.unknown
    }
    return unknown ? 'unknown' : null
  } catch {
    return 'unknown'
  }
}

function localGitProbeExec(path: string, options: LocalGitExecOptions) {
  const execOptions = gitExecOptions(path, options)
  return (
    argv: string[],
    commandOptions?: ExactRefProbeExecOptions & { stdin?: string }
  ): Promise<{ stdout: string }> =>
    gitExecFileAsync(argv, {
      ...execOptions,
      ...(commandOptions?.maxBuffer === undefined ? {} : { maxBuffer: commandOptions.maxBuffer }),
      ...(commandOptions?.timeoutMs === undefined ? {} : { timeout: commandOptions.timeoutMs }),
      ...(commandOptions?.stdin === undefined ? {} : { stdin: commandOptions.stdin })
    })
}

export function getBranchConflictKindStrict(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {}
): Promise<StrictBranchConflictKind | null> {
  const runLocalGit = localGitProbeExec(path, options)
  return getBranchConflictKindStrictViaExec(
    runLocalGit,
    branchName,
    allowedBaseRef,
    {},
    runLocalGit
  )
}

export function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {},
  allowLocalBranch?: () => Promise<boolean>
): Promise<BranchConflictKind | null> {
  const runLocalGit = localGitProbeExec(path, options)
  return getBranchConflictKindViaExec(
    runLocalGit,
    branchName,
    allowedBaseRef,
    {},
    runLocalGit,
    allowLocalBranch
  )
}

function isAllowedRemoteBaseRef(refName: string, allowedBaseRef: string | undefined): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}
