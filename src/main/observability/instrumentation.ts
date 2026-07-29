// Convenience wrappers around the tracer for the span boundaries listed in
// telemetry-error-tracking.md §"Span boundaries worth capturing":
//
//   - IPC boundaries (renderer → main preload calls)
//   - Agent session lifecycle (start, turn, stop, recover)
//   - Git command execution
//   - Worktree setup (clone / checkout / install)
//   - PTY session lifecycle
//   - External editor launches
//   - Updater operations
//
// Each helper wraps `withSpan` from `tracer.ts` with a sensible default
// span name and a small attribute pack. Call sites that already produce
// detailed Result objects (git runner returning stdout/stderr; PTY layer
// reporting exit codes) thread that detail in via `attributes` so the
// span attribute pack stays cohesive without each call site re-inventing
// keys.
//
// All helpers are no-ops when the tracer's active sink is unset (the
// observability lane was disabled at startup by env var or CI). The span
// itself becomes a `noopSpan` that swallows all calls — call sites do not
// need to branch on whether tracing is on.

import { withSpan, type ActiveSpan } from './tracer'

const GIT_FAST_SUCCESS_THRESHOLD_MS = 250
const GIT_FAST_SUCCESS_WINDOW_MS = 60_000
const GIT_FAST_SUCCESS_BUDGET_PER_WINDOW = 60
const GIT_SAMPLING_MAX_BUCKETS = 512

// Why: trace captures showed `git status --short` bursts dominating payloads.
// Keep enough fast successes for timing shape while bounding memory and volume.
const GIT_GLOBAL_OPTIONS_WITH_OPERAND = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--config-env',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--pathspec-from-file'
])
const GIT_GLOBAL_FLAGS = new Set([
  '--bare',
  '--no-pager',
  '--paginate',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--pathspec-file-nul'
])

type GitSamplingBucket = {
  windowStartMs: number
  emitted: number
}

const gitSamplingBuckets = new Map<string, GitSamplingBucket>()

function gitSubcommandFromArgs(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) {
      continue
    }
    if (arg === '--') {
      return '<none>'
    }
    if (GIT_GLOBAL_OPTIONS_WITH_OPERAND.has(arg)) {
      index += 1
      continue
    }
    if (
      arg.startsWith('--git-dir=') ||
      arg.startsWith('--work-tree=') ||
      arg.startsWith('--config-env=') ||
      arg.startsWith('--namespace=') ||
      arg.startsWith('--exec-path=') ||
      arg.startsWith('--super-prefix=') ||
      arg.startsWith('--pathspec-from-file=') ||
      (arg.startsWith('-c') && arg.length > 2) ||
      (arg.startsWith('-C') && arg.length > 2)
    ) {
      continue
    }
    if (GIT_GLOBAL_FLAGS.has(arg)) {
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    return arg
  }
  return '<none>'
}

function pruneGitSamplingBuckets(nowMs: number): void {
  for (const [key, bucket] of gitSamplingBuckets) {
    if (nowMs - bucket.windowStartMs >= GIT_FAST_SUCCESS_WINDOW_MS) {
      gitSamplingBuckets.delete(key)
    }
  }
  while (gitSamplingBuckets.size > GIT_SAMPLING_MAX_BUCKETS) {
    let oldestKey: string | undefined
    let oldestWindowStartMs = Number.POSITIVE_INFINITY
    for (const [key, bucket] of gitSamplingBuckets) {
      if (bucket.windowStartMs < oldestWindowStartMs) {
        oldestKey = key
        oldestWindowStartMs = bucket.windowStartMs
      }
    }
    if (oldestKey === undefined) {
      return
    }
    gitSamplingBuckets.delete(oldestKey)
  }
}

function gitSamplingKey(meta: GitSpanArgs): string {
  return `${gitSubcommandFromArgs(meta.args)}\u0000${meta.cwd ?? '<none>'}`
}

function shouldRecordGitSpan(
  meta: GitSpanArgs,
  record: { durationMs: number; startTimeUnixNano: string; exit: { _tag: string } }
): boolean {
  if (record.exit._tag !== 'Success' || record.durationMs >= GIT_FAST_SUCCESS_THRESHOLD_MS) {
    return true
  }

  const nowMs = Number(BigInt(record.startTimeUnixNano) / 1_000_000n)
  pruneGitSamplingBuckets(nowMs)
  const key = gitSamplingKey(meta)
  const bucket = gitSamplingBuckets.get(key)
  if (!bucket) {
    gitSamplingBuckets.set(key, { windowStartMs: nowMs, emitted: 1 })
    pruneGitSamplingBuckets(nowMs)
    return true
  }
  if (bucket.emitted < GIT_FAST_SUCCESS_BUDGET_PER_WINDOW) {
    bucket.emitted += 1
    return true
  }
  return false
}

function addGitAttributes(span: ActiveSpan, meta: GitSpanArgs): void {
  span.setAttribute('git.subcommand', gitSubcommandFromArgs(meta.args))
  // Why: git args can contain commit messages, branch names, remotes, or
  // paths. Keep cardinality without copying user-authored content.
  span.setAttribute('git.arg_count', meta.args.length)
  if (meta.cwd) {
    span.setAttribute('cwd', meta.cwd)
  }
}

export function _resetGitSpanSamplingForTests(): void {
  gitSamplingBuckets.clear()
}

export function _gitSpanSamplingBucketCountForTests(): number {
  return gitSamplingBuckets.size
}

export type GitSpanArgs = {
  readonly args: readonly string[]
  readonly cwd?: string
}

/** Wrap a git execution in a `git.exec` span. Git accepts global options before
 *  the subcommand; promoting the parsed command to its own attribute makes it
 *  grep-friendly without copying the full args array into dashboards. */
export async function withGitSpan<T>(meta: GitSpanArgs, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    'git.exec',
    async (span) => {
      addGitAttributes(span, meta)
      return await fn()
    },
    { attributes: { kind: 'git' }, shouldRecord: (record) => shouldRecordGitSpan(meta, record) }
  )
}

export type WorktreeSpanArgs = {
  readonly stage: 'clone' | 'checkout' | 'install' | 'create' | 'remove'
  readonly path?: string
}

/** Wrap a worktree-setup phase in a `worktree.<stage>` span. */
export async function withWorktreeSpan<T>(
  meta: WorktreeSpanArgs,
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(
    `worktree.${meta.stage}`,
    async (span) => {
      span.setAttribute('worktree.stage', meta.stage)
      if (meta.path) {
        span.setAttribute('worktree.path', meta.path)
      }
      return await fn()
    },
    { attributes: { kind: 'worktree' } }
  )
}

export type PtySpanArgs = {
  readonly stage: 'spawn' | 'exit' | 'recover'
  readonly shell?: string
  readonly cwd?: string
}

/** Wrap a PTY-lifecycle event in a `pty.<stage>` span. The lifecycle is
 *  long-lived; callers typically use `startSpan` directly for the live
 *  session and call `withPtySpan` only for the spawn/exit moments. */
export async function withPtySpan<T>(meta: PtySpanArgs, fn: () => Promise<T> | T): Promise<T> {
  return withSpan(
    `pty.${meta.stage}`,
    async (span) => {
      span.setAttribute('pty.stage', meta.stage)
      if (meta.shell) {
        span.setAttribute('pty.shell', meta.shell)
      }
      if (meta.cwd) {
        span.setAttribute('cwd', meta.cwd)
      }
      return await fn()
    },
    { attributes: { kind: 'pty' } }
  )
}

export type UpdaterSpanArgs = {
  readonly stage: 'check' | 'download' | 'install'
}

export async function withUpdaterSpan<T>(
  meta: UpdaterSpanArgs,
  fn: (span: ActiveSpan) => Promise<T> | T
): Promise<T> {
  return withSpan(
    `updater.${meta.stage}`,
    async (span) => {
      span.setAttribute('updater.stage', meta.stage)
      return await fn(span)
    },
    { attributes: { kind: 'updater' } }
  )
}
