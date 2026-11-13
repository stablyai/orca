import { hasActiveTraceSink, startSpan, withSpan, type ActiveSpan } from './tracer'
import { getGitOperationCause } from './git-operation-cause'
import { resolveGitAdmissionTier } from '../git/command-runner/admission/git-operation-executor'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'

const GIT_ACTION_NAMES: Record<string, readonly string[]> = {
  worktree: ['list', 'add', 'remove', 'move', 'prune', 'lock', 'unlock', 'repair'],
  remote: ['get-url', 'set-url', 'add', 'remove', 'rename', 'show']
}

const GIT_FAST_SUCCESS_THRESHOLD_MS = 250
const GIT_FAST_SUCCESS_WINDOW_MS = 60_000
const GIT_FAST_SUCCESS_BUDGET_PER_WINDOW = 60
const GIT_SAMPLING_MAX_BUCKETS = 512

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

function gitSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) {
      continue
    }
    if (arg === '--') {
      return -1
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
    return index
  }
  return -1
}

function gitSubcommandFromArgs(args: readonly string[]): string {
  return args[gitSubcommandIndex(args)] ?? '<none>'
}

function gitArgvShape(args: readonly string[]): string {
  const index = gitSubcommandIndex(args)
  if (index < 0) {
    return '<none>'
  }
  const subcommand = args[index] ?? '<none>'
  let name = /^[a-z][a-z0-9-]*$/.test(subcommand) ? subcommand : '<none>'
  const action = args[index + 1]
  if (
    Object.hasOwn(GIT_ACTION_NAMES, subcommand) &&
    GIT_ACTION_NAMES[subcommand].includes(action)
  ) {
    name += ` ${action}`
  }
  for (let i = index + 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      break
    }
    // Discard option values, including attached short-option operands.
    const flag = /^(--[a-z][a-z0-9-]*)(?:=|$)/.exec(arg)?.[1] ?? /^(-[a-zA-Z])/.exec(arg)?.[1]
    if (flag) {
      return `${name} ${flag}`
    }
  }
  return name
}

function gitCommandVariant(args: readonly string[]): string {
  const index = gitSubcommandIndex(args)
  switch (args[index]) {
    case 'worktree': {
      const operation = args[index + 1]
      if (operation === 'list') {
        return args.includes('-z') ? 'worktree-list-z' : 'worktree-list-legacy'
      }
      return operation === 'add' || operation === 'remove' || operation === 'move'
        ? `worktree-${operation}`
        : 'worktree-other'
    }
    case 'for-each-ref':
      return args.includes('--sort=-committerdate') ? 'refs-date-sort' : 'refs-other'
    case 'fetch':
      return args.some((arg) => arg.startsWith('+refs/heads/') && arg.includes(':refs/'))
        ? 'fetch-exact-base'
        : 'fetch-other'
    case 'rev-parse':
      return args.includes('--git-path') ? 'git-path' : 'rev-parse-other'
    default:
      return 'other'
  }
}

function safeGitSpan(span: ActiveSpan): ActiveSpan {
  return {
    ...span,
    fail(cause) {
      const name = cause instanceof Error ? cause.name : undefined
      span.fail(
        name === 'AbortError'
          ? 'Git command cancelled'
          : name === 'GitCommandTimeoutError'
            ? 'Git command timed out'
            : 'Git command failed'
      )
    },
    interrupt() {
      span.interrupt('Git command cancelled')
    }
  }
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
  // Git arguments may contain user content; record counts instead.
  span.setAttribute('git.arg_count', meta.args.length)
  span.setAttribute('git.variant', gitCommandVariant(meta.args))
  const cause = getGitOperationCause()
  span.setAttribute('git.caller', cause?.reason ?? 'unattributed')
  span.setAttribute('git.argv_shape', gitArgvShape(meta.args))
  const tier = resolveGitAdmissionTier(meta.admissionTier)
  span.setAttribute('git.admission_tier', tier)
  span.setAttribute('git.foreground', tier === 'status' ? 'unknown' : tier === 'interactive')
  if (cause) {
    span.setAttribute('git.operation', cause.family)
    span.setAttribute('git.reason', cause.reason)
    span.setAttribute('git.cache', cause.cache)
    span.setAttribute('git.common_dir_hash', cause.commonDirHash ?? 'unknown')
  }
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
  readonly admissionTier?: GitAdmissionTier
}

export async function withGitSpan<T>(
  meta: GitSpanArgs,
  fn: (span: ActiveSpan) => Promise<T>
): Promise<T> {
  if (!hasActiveTraceSink()) {
    return fn(startSpan('git.exec'))
  }
  return withSpan(
    'git.exec',
    async (span) => {
      addGitAttributes(span, meta)
      const safeSpan = safeGitSpan(span)
      try {
        return await fn(safeSpan)
      } catch (error) {
        safeSpan.fail(error instanceof Error ? error : 'Git command failed')
        throw error
      }
    },
    { attributes: { kind: 'git' }, shouldRecord: (record) => shouldRecordGitSpan(meta, record) }
  )
}

export function startGitSpan(meta: GitSpanArgs): ActiveSpan {
  if (!hasActiveTraceSink()) {
    return startSpan('git.exec')
  }
  const span = startSpan('git.exec', {
    attributes: { kind: 'git' },
    shouldRecord: (record) => shouldRecordGitSpan(meta, record)
  })
  addGitAttributes(span, meta)
  return safeGitSpan(span)
}
