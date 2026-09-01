import { resolveConfiguredRemoteBranchName } from './repo-base-ref-search'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import {
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
  // Validate the complete local ref before interpolating the name into any Git
  // argument. This rejects glob/control/refspec syntax while retaining valid
  // slash-containing branch names.
  return !branchName.startsWith('-') && isSafeGitRefName(`refs/heads/${branchName}`)
}

async function hasGitRefAsync(
  exec: ExactRefProbeExec,
  ref: string,
  options: ExactRefProbeExecOptions
): Promise<boolean> {
  try {
    const { stdout } = await runGit(exec, ['rev-parse', '--verify', ref], options)
    return stdout.trim().length > 0
  } catch {
    return false
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
    // Match the conflict policy's longest-remote-prefix interpretation when
    // remote names overlap (for example, `foo` and `foo/bar`).
    if (
      !isAllowedRemoteBaseRef(ref, allowedBaseRef) &&
      resolveConfiguredRemoteBranchName(ref, remoteNames) === branchName
    ) {
      refs.add(ref)
    }
  }
  return [...refs]
}

/** One batched child answers for every remote; the per-ref probes only run when the host cannot
 *  feed stdin, or when the batch came back undecided. */
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
    if (batched.found) {
      return { found: true }
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
  batchedExec?: ExactRefProbeStdinExec
): Promise<BranchConflictKind | null> {
  if (!canQueryRemoteBranchName(branchName)) {
    return null
  }
  // Preserve the host runner's existing output/timeout contract. Exact probes
  // are quiet, so introducing a smaller implicit cap would only make a large
  // remote configuration look like a missing conflict.
  const probeOptions: ExactRefProbeExecOptions = options
  if (await hasGitRefAsync(exec, `refs/heads/${branchName}`, probeOptions)) {
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
  options: LocalGitExecOptions = {}
): Promise<BranchConflictKind | null> {
  const execOptions = gitExecOptions(path, options)
  const runLocalGit = (
    argv: string[],
    commandOptions?: ExactRefProbeExecOptions & { stdin?: string }
  ): Promise<{ stdout: string }> =>
    gitExecFileAsync(argv, {
      ...execOptions,
      ...(commandOptions?.maxBuffer === undefined ? {} : { maxBuffer: commandOptions.maxBuffer }),
      ...(commandOptions?.timeoutMs === undefined ? {} : { timeout: commandOptions.timeoutMs }),
      ...(commandOptions?.stdin === undefined ? {} : { stdin: commandOptions.stdin })
    })
  return getBranchConflictKindViaExec(
    runLocalGit,
    branchName,
    allowedBaseRef,
    {},
    (argv, commandOptions) => runLocalGit(argv, commandOptions)
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
