import { resolveConfiguredRemoteBranchName } from './repo-base-ref-search'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import {
  isShowRefNoMatchError,
  probeAnyExactRef,
  probeAnyExactRefBatched,
  type ExactRefProbeExec,
  type ExactRefProbeExecOptions,
  type ExactRefProbeStdinExec
} from './exact-ref-probe'

export type BranchConflictKind = 'local' | 'remote'

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

async function listRemoteNamesViaExec(
  exec: ExactRefProbeExec,
  options: ExactRefProbeExecOptions
): Promise<string[]> {
  try {
    const { stdout } = await runGit(exec, ['remote'], options)
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return []
  }
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
): Promise<{ found: boolean }> {
  if (batchedExec) {
    const batched = await probeAnyExactRefBatched(batchedExec, candidateRefs, probeOptions)
    if (!batched.unknown) {
      return { found: batched.found }
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

export function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {},
  allowLocalBranch?: () => Promise<boolean>
): Promise<BranchConflictKind | null> {
  const execOptions = gitExecOptions(path, options)
  const runLocalGit = (
    argv: string[],
    commandOptions?: ExactRefProbeExecOptions & { stdin?: string },
    captureWslLoginShellOutput = false
  ): Promise<{ stdout: string }> =>
    gitExecFileAsync(argv, {
      ...execOptions,
      ...(captureWslLoginShellOutput ? { captureWslLoginShellOutput: true } : {}),
      ...(commandOptions?.maxBuffer === undefined ? {} : { maxBuffer: commandOptions.maxBuffer }),
      ...(commandOptions?.timeoutMs === undefined ? {} : { timeout: commandOptions.timeoutMs }),
      ...(commandOptions?.stdin === undefined ? {} : { stdin: commandOptions.stdin })
    })
  return getBranchConflictKindViaExec(
    (argv, commandOptions) => runLocalGit(argv, commandOptions, argv[0] === 'for-each-ref'),
    branchName,
    allowedBaseRef,
    {},
    // Fence login banners to preserve one stdout line per ref; quiet exit-code probes need no markers.
    (argv, commandOptions) => runLocalGit(argv, commandOptions, true),
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
