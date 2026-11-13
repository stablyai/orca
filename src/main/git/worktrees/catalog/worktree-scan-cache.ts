import { abortSignalReason } from '../../../../shared/abort-signal-reason'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  annotateSparseCheckoutStatus,
  listWorktreeGraph as listWorktreeGraphUnshared,
  listWorktreesStrict as listWorktreesStrictUnshared
} from './worktree-listing'
import { listWorktreesStrictAllowingTrueEmpty as listWorktreesStrictAllowingTrueEmptyUnshared } from './strict-true-empty-worktree-listing'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { WORKTREE_LIST_TIMEOUT_MS } from '../worktree-operation-options'
import { resolveGitAdmissionTier } from '../../command-runner/admission/git-operation-executor'

let signalIdentities = new WeakMap<AbortSignal, number>()
let nextSignalIdentity = 0

const inFlightWorktreeScans = new Map<string, Promise<GitWorktreeInfo[]>>()

type WorktreeScanKind = 'graph' | 'lenient' | 'strict' | 'strict-true-empty'

const worktreeScanGenerations = new Map<string, number>()

function hasInFlightWorktreeScanForRepo(repoPath: string): boolean {
  const keyPrefix = `${repoPath}\0`
  for (const key of inFlightWorktreeScans.keys()) {
    if (key.startsWith(keyPrefix)) {
      return true
    }
  }
  return false
}

const scanGenerationBumpListeners = new Set<(repoPath: string) => void>()

/** Settled catalog owners outlive in-flight scans, so mutations must reach them too. */
export function onWorktreeScanGenerationBump(listener: (repoPath: string) => void): void {
  scanGenerationBumpListeners.add(listener)
}

export function bumpWorktreeScanGeneration(repoPath: string): void {
  for (const listener of scanGenerationBumpListeners) {
    listener(repoPath)
  }
  // Retain generations only while a pre-mutation scan can still be joined.
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    return
  }
  worktreeScanGenerations.set(repoPath, (worktreeScanGenerations.get(repoPath) ?? 0) + 1)
}

function pruneWorktreeScanGeneration(repoPath: string): void {
  // Avoid cross-generation scans on ordinary settlement.
  if (!worktreeScanGenerations.has(repoPath)) {
    return
  }
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    worktreeScanGenerations.delete(repoPath)
  }
}

export function _getWorktreeScanCacheSizesForTests(): { inFlight: number; generations: number } {
  return {
    inFlight: inFlightWorktreeScans.size,
    generations: worktreeScanGenerations.size
  }
}

export function _resetWorktreeScanCacheForTests(): void {
  signalIdentities = new WeakMap()
  nextSignalIdentity = 0
  inFlightWorktreeScans.clear()
  worktreeScanGenerations.clear()
}

/** Explicit kinds preserve failure semantics and cache identity even when bundlers rename functions. */
function shareWorktreeScan(
  repoPath: string,
  options: GitWorktreeExecOptions,
  kind: WorktreeScanKind,
  run: (repoPath: string, options: GitWorktreeExecOptions) => Promise<GitWorktreeInfo[]>
): Promise<GitWorktreeInfo[]> {
  if (options.signal?.aborted) {
    return Promise.reject(abortSignalReason(options.signal))
  }
  let signalIdentity = 0
  if (options.signal) {
    signalIdentity = signalIdentities.get(options.signal) ?? ++nextSignalIdentity
    signalIdentities.set(options.signal, signalIdentity)
  }
  const generation = worktreeScanGenerations.get(repoPath) ?? 0
  const timeout = options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  // Separate deadlines, failure contracts and admission tiers so joiners cannot inherit weaker scans.
  const key = `${repoPath}\0${options.wslDistro ?? ''}\0${timeout}\0${options.includeCreatePreparations === true}\0${generation}\0${kind}\0${resolveGitAdmissionTier(options.admissionTier)}\0${signalIdentity}`
  const inFlight = inFlightWorktreeScans.get(key)
  if (inFlight) {
    return inFlight
  }
  const scan = run(repoPath, options).finally(() => {
    if (inFlightWorktreeScans.get(key) === scan) {
      inFlightWorktreeScans.delete(key)
    }
    pruneWorktreeScanGeneration(repoPath)
  })
  inFlightWorktreeScans.set(key, scan)
  return scan
}

/** Add sparse annotations to the shared lenient graph scan without spawning another Git subprocess. */
async function runAnnotatedWorktreeScan(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  const worktrees = await listWorktreeGraph(repoPath, options)
  return annotateSparseCheckoutStatus(repoPath, worktrees, options)
}

/** Git failures return []; matching callers coalesce, while different cancellation scopes stay isolated. */
export function listWorktrees(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'lenient', runAnnotatedWorktreeScan)
}

/** Skip sparse probes while retaining generation fencing and cancellation-scope isolation. */
export function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'graph', listWorktreeGraphUnshared)
}

/** Coalesce strict reads separately so Git failures still reject. */
export function listWorktreesSharedStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(repoPath, options, 'strict', listWorktreesStrictUnshared)
}

/** Isolate scans that reject failures but return [] for confirmed missing/non-repos. */
export function listWorktreesSharedStrictAllowingTrueEmpty(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return shareWorktreeScan(
    repoPath,
    options,
    'strict-true-empty',
    listWorktreesStrictAllowingTrueEmptyUnshared
  )
}
