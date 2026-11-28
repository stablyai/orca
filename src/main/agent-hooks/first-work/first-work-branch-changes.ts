import type { BranchNameChanges } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import {
  GIT_READ_TIMEOUT_MS,
  GitCommandTimeoutError
} from '../../../shared/git/commands/git-command-timeout'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import type { GitExecOptions } from '../../git/command-runner/git-exec-options'
import { isQuietGitControlFlowExit } from '../../git/command-runner/host-routing/git-command-resolution'
import {
  gitOptionalLocksDisabledEnv,
  offlineGitEnv
} from '../../git/command-runner/git-environment/git-process-env'

export type BranchChangesLookup =
  | { kind: 'changes'; changes: BranchNameChanges }
  | { kind: 'nothing-yet' }
  /** An operational Git failure, timeout or abort: retryable, never partial evidence. */
  | { kind: 'unreadable' }

type GitCapture =
  | { kind: 'ok'; stdout: string }
  /** Clipped at maxBuffer by an otherwise successful command. */
  | { kind: 'truncated'; stdout: string }
  /** Exit 1 with empty stderr: Git's answer of "absent", not a failure. */
  | { kind: 'quiet-exit' }
  | { kind: 'failed' }

type GitRunner = (args: string[], options: GitExecOptions) => Promise<{ stdout: string }>

const EVIDENCE_MAX_BUFFER = 256 * 1024
const UNTRACKED_MAX_BUFFER = 64 * 1024
const STAT_ARGS = ['--no-ext-diff', '--no-color', '--stat=200', '--stat-count=200']
// Paths reach the naming model, so non-ASCII names must not be octal-escaped.
const UNQUOTED_PATHS = ['-c', 'core.quotePath=false']

/** The exit facts the termination-barrier route attaches to a thrown capture error. */
type GitExitFields = {
  code?: unknown
  signal?: unknown
  killed?: unknown
  outputTruncated?: unknown
  stdout?: unknown
}

function parseGitExitFields(error: unknown): GitExitFields {
  if (error === null || typeof error !== 'object') {
    return {}
  }
  return {
    code: 'code' in error ? error.code : undefined,
    signal: 'signal' in error ? error.signal : undefined,
    killed: 'killed' in error ? error.killed : undefined,
    outputTruncated: 'outputTruncated' in error ? error.outputTruncated : undefined,
    stdout: 'stdout' in error ? error.stdout : undefined
  }
}

/** Abort and timeout outrank clipping; clipping counts only with a clean exit the route observed. */
export function classifyGitCaptureError(
  error: unknown,
  signal: AbortSignal | undefined,
  maxBuffer: number
): GitCapture {
  if (signal?.aborted || error instanceof GitCommandTimeoutError) {
    return { kind: 'failed' }
  }
  const exit = parseGitExitFields(error)
  const truncated = exit.outputTruncated === true
  if (truncated && exit.code === 0 && exit.killed !== true && (exit.signal ?? null) === null) {
    const stdout = typeof exit.stdout === 'string' ? exit.stdout : ''
    // The flag also covers stderr; below the cap, stdout is complete and only diagnostics were clipped.
    return stdoutReachedCap(stdout, maxBuffer)
      ? { kind: 'truncated', stdout }
      : { kind: 'ok', stdout }
  }
  if (!truncated && isQuietGitControlFlowExit(error)) {
    return { kind: 'quiet-exit' }
  }
  return { kind: 'failed' }
}

// A clipped UTF-8 stream may stop up to one partial character short of the byte cap.
function stdoutReachedCap(stdout: string, maxBuffer: number): boolean {
  return Buffer.byteLength(stdout) >= maxBuffer - 3
}

function evidenceText(capture: GitCapture): string | null {
  if (capture.kind === 'ok') {
    return capture.stdout.trim()
  }
  if (capture.kind === 'truncated') {
    const complete = capture.stdout.slice(0, capture.stdout.lastIndexOf('\n') + 1).trim()
    return `${complete}\n…`.trim()
  }
  return null
}

/** Local Git evidence since the branch left its base; never fetches. */
export async function readBranchChangesForNaming(args: {
  cwd: string
  baseRef: string | undefined
  signal: AbortSignal
  deadlineAt: number
  runGit?: GitRunner
}): Promise<BranchChangesLookup> {
  const runGit = args.runGit ?? gitExecFileAsync
  const capture = async (gitArgs: string[], maxBuffer = EVIDENCE_MAX_BUFFER) => {
    const live = () => !args.signal.aborted && Date.now() < args.deadlineAt
    if (!live()) {
      return { kind: 'failed' } as const
    }
    try {
      const { stdout } = await runGit(gitArgs, {
        cwd: args.cwd,
        // Evidence is local by contract: no lazy partial-clone fetch, no transport, no index refresh.
        env: gitOptionalLocksDisabledEnv(offlineGitEnv()),
        maxBuffer,
        timeout: Math.min(GIT_READ_TIMEOUT_MS, Math.max(1, args.deadlineAt - Date.now())),
        signal: args.signal,
        // Rechecked after admission and before any routed fallback, so expiry never launches a child.
        canStart: live,
        // The barrier route reports exit status alongside clipping, so precedence is observable.
        terminationBarrier: true
      })
      return { kind: 'ok', stdout } as const
    } catch (error) {
      return classifyGitCaptureError(error, args.signal, maxBuffer)
    }
  }

  const base = await resolveMergeBase(args.baseRef, capture)
  if (base.kind === 'unreadable') {
    return { kind: 'unreadable' }
  }
  const mergeBase = base.kind === 'merge-base' ? base.sha : null
  const [commits, working, staged, untracked] = await Promise.all([
    mergeBase
      ? capture([
          'log',
          '--no-show-signature',
          '--no-color',
          '--pretty=format:- %s',
          '--max-count=50',
          `${mergeBase}..HEAD`
        ])
      : Promise.resolve<GitCapture>({ kind: 'ok', stdout: '' }),
    capture([...UNQUOTED_PATHS, 'diff', ...STAT_ARGS, mergeBase ?? 'HEAD']),
    // The index is read on its own: staged work can cancel out of the working-tree diff.
    capture([...UNQUOTED_PATHS, 'diff', '--cached', ...STAT_ARGS]),
    capture(
      [
        ...UNQUOTED_PATHS,
        'ls-files',
        '--others',
        '--exclude-standard',
        '--directory',
        '--no-empty-directory'
      ],
      UNTRACKED_MAX_BUFFER
    )
  ])
  const commitSubjects = evidenceText(commits)
  const workingStat = evidenceText(working)
  const stagedStat = evidenceText(staged)
  const untrackedNames = evidenceText(untracked)
  if (
    args.signal.aborted ||
    Date.now() >= args.deadlineAt ||
    commitSubjects === null ||
    workingStat === null ||
    stagedStat === null ||
    untrackedNames === null
  ) {
    return { kind: 'unreadable' }
  }
  if (!commitSubjects && !workingStat && !stagedStat && !untrackedNames) {
    return { kind: 'nothing-yet' }
  }
  return {
    kind: 'changes',
    changes: { commitSubjects, workingStat, stagedStat, untracked: untrackedNames }
  }
}

type MergeBase = { kind: 'merge-base'; sha: string } | { kind: 'no-base' } | { kind: 'unreadable' }

/** No-base is an expected absence (missing ref or no common ancestor); other failures are unreadable. */
async function resolveMergeBase(
  baseRef: string | undefined,
  capture: (args: string[]) => Promise<GitCapture>
): Promise<MergeBase> {
  const ref = baseRef?.trim()
  if (!ref || ref.startsWith('-')) {
    return { kind: 'no-base' }
  }
  const verified = await capture(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (verified.kind === 'quiet-exit') {
    return { kind: 'no-base' }
  }
  if (verified.kind !== 'ok' || !verified.stdout.trim()) {
    return { kind: 'unreadable' }
  }
  const mergeBase = await capture(['merge-base', verified.stdout.trim(), 'HEAD'])
  if (mergeBase.kind === 'quiet-exit') {
    return { kind: 'no-base' }
  }
  return mergeBase.kind === 'ok' && mergeBase.stdout.trim()
    ? { kind: 'merge-base', sha: mergeBase.stdout.trim() }
    : { kind: 'unreadable' }
}
