import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import { isRemoteHeadRef } from '../../shared/hosted-review-refs'
import { isSafeReviewHeadFetchRemote } from '../../shared/review-head-tracking-ref'
import { probeExactRefs, type ExactRefProbeExecOptions } from '../git/exact-ref-probe'

export type PullRequestGitExec = (
  args: string[],
  options?: { maxBuffer?: number; timeoutMs?: number }
) => Promise<{ stdout: string; stderr?: string }>

export type PullRequestRemoteRefState = {
  remotes: string[]
  refs: string[]
  probeUnknown: boolean
}

function* iterateGitOutputLines(output: string): Generator<string> {
  let lineStart = 0
  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }
    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }
  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

function splitGitLines(output: string): string[] {
  const lines: string[] = []
  for (const rawLine of iterateGitOutputLines(output)) {
    const line = rawLine.trim()
    if (line.length > 0 && isSafeReviewHeadFetchRemote(line)) {
      lines.push(line)
    }
  }
  return lines
}

/** Keep stale tracking refs from turning an unconfigured remote into a fetch option. */
function hasSafeRemoteComponent(ref: string, remotes: readonly string[]): boolean {
  const shortRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => shortRef.startsWith(`${candidate}/`))
  const fallbackRemote = shortRef.split('/')[0] ?? ''
  return isSafeReviewHeadFetchRemote(remote ?? fallbackRemote)
}

async function safeExec(
  execGit: PullRequestGitExec,
  args: string[],
  options: ExactRefProbeExecOptions
): Promise<string> {
  try {
    const { stdout } = await execGit(args, options)
    return stdout.trim()
  } catch {
    return ''
  }
}

export function canQueryRemoteBaseRefs(base: string): boolean {
  return isSafeGitRefName(`refs/remotes/${base}`)
}

async function listExactRemoteBaseRefs(
  execGit: PullRequestGitExec,
  base: string,
  remotes: readonly string[],
  options: ExactRefProbeExecOptions
): Promise<{ refs: string[]; probeUnknown: boolean }> {
  // A base is qualified only when its first components name a configured
  // remote. A slash-containing branch such as `feature/fix` still needs the
  // conventional and configured-remote candidates below.
  const isConfiguredQualifiedBase =
    base.includes('/') && remotes.some((remote) => base.startsWith(`${remote}/`))
  // A bare name is a branch suffix, not a complete remote-tracking ref. Only
  // probe the complete spelling when the caller supplied a slash-qualified
  // candidate; this avoids an extra process for refs/remotes/<branch>.
  const exactRefNames = new Set<string>([
    ...(base.includes('/') ? [base] : []),
    ...(isConfiguredQualifiedBase
      ? []
      : [`origin/${base}`, `upstream/${base}`, ...remotes.map((remote) => `${remote}/${base}`)])
  ])
  const refs = [...exactRefNames].filter((ref) => isSafeGitRefName(`refs/remotes/${ref}`))
  const qualifiedRefs = refs.map((ref) => `refs/remotes/${ref}`)
  const result = await probeExactRefs(execGit, qualifiedRefs, options)
  const present = new Set(result.presentRefs)
  return {
    refs: refs.filter((ref) => present.has(`refs/remotes/${ref}`)),
    probeUnknown: result.unknownRefs.length > 0
  }
}

function parseSuffixRemoteRefs(output: string, base: string, remotes: readonly string[]): string[] {
  const refs = new Set<string>()
  for (const line of iterateGitOutputLines(output)) {
    const separator = line.indexOf(' ')
    if (separator === -1) {
      continue
    }
    const fullRef = line.slice(separator + 1).trim()
    if (!fullRef.startsWith('refs/remotes/') || !isSafeGitRefName(fullRef)) {
      continue
    }
    if (!hasSafeRemoteComponent(fullRef, remotes)) {
      continue
    }
    const shortRef = fullRef.slice('refs/remotes/'.length)
    // A remote-tracking ref has both a remote and branch component. Ignore a
    // malformed bare `refs/remotes/<name>` entry from the suffix stream.
    if (
      !shortRef.includes('/') ||
      isRemoteHeadRef(shortRef, remotes) ||
      // A bare `HEAD` denotes the remote's symbolic slot, not every branch
      // whose final component happens to be `HEAD` (for example `feature/HEAD`).
      (base === 'HEAD' && shortRef.endsWith('/HEAD')) ||
      (shortRef !== base && !shortRef.endsWith(`/${base}`))
    ) {
      continue
    }
    refs.add(shortRef)
    // Resolution only distinguishes zero, one, and multiple candidates; cap
    // retained state once ambiguity is proven.
    if (refs.size >= 2) {
      break
    }
  }
  return [...refs]
}

async function listSuffixRemoteBaseRefs(
  execGit: PullRequestGitExec,
  base: string,
  remotes: readonly string[],
  options: ExactRefProbeExecOptions
): Promise<string[]> {
  // show-ref streams; maxBuffer bounds the captured suffix fallback.
  try {
    const { stdout } = await execGit(['show-ref', '--', base], options)
    return parseSuffixRemoteRefs(stdout, base, remotes)
  } catch {
    // Output overflow or transport failure is an inconclusive suffix lookup;
    // retain the bare candidate rather than blocking generation.
    return []
  }
}

function shouldSearchSuffixRemoteRefs(
  base: string,
  remotes: readonly string[],
  refs: readonly string[],
  probeUnknown: boolean
): boolean {
  if (
    probeUnknown ||
    refs.length >= 2 ||
    refs.includes(base) ||
    remotes.some((remote) => base.startsWith(`${remote}/`))
  ) {
    return false
  }
  return !['origin', 'upstream'].some(
    (remote) => remotes.includes(remote) || refs.includes(`${remote}/${base}`)
  )
}

export async function getPullRequestRemoteRefState(
  execGit: PullRequestGitExec,
  base: string,
  maxBuffer: number
): Promise<PullRequestRemoteRefState> {
  const probeOptions: ExactRefProbeExecOptions = { maxBuffer }
  const queryable = canQueryRemoteBaseRefs(base)
  const remotes = splitGitLines(await safeExec(execGit, ['remote'], probeOptions))
  const exactResult = queryable
    ? await listExactRemoteBaseRefs(execGit, base, remotes, probeOptions)
    : { refs: [], probeUnknown: false }
  const suffixRefs =
    queryable &&
    shouldSearchSuffixRemoteRefs(base, remotes, exactResult.refs, exactResult.probeUnknown)
      ? await listSuffixRemoteBaseRefs(execGit, base, remotes, probeOptions)
      : []
  return {
    remotes,
    refs: [...new Set([...exactResult.refs, ...suffixRefs])].filter(
      (ref) => !isRemoteHeadRef(ref, remotes) && hasSafeRemoteComponent(ref, remotes)
    ),
    probeUnknown: exactResult.probeUnknown
  }
}
