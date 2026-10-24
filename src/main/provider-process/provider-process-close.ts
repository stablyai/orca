import type {
  PipedProcessSpawner,
  PipedChildProcess,
  SpawnedProcess
} from '@orca/process-host/process-spec'
import type { ProviderProcessOutputOptions } from './provider-process-output'
import type { ProviderResource, ProviderResourceResult } from './provider-process-inventory'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { PROVIDER_STDIN_END_GRACE_MS } from './provider-process-timing'
import {
  waitForProcessExitUntil,
  type ProviderCleanupBudget
} from './provider-process-exit-deadline'
import type { ProviderProcessTeardownVerdict } from './provider-process-teardown'

export type ProviderProcessTree = {
  capture(): Promise<void>
  refresh?: () => Promise<void>
  reap(): Promise<DescendantTreeVerdict>
  readonly treeVerdict: DescendantTreeVerdict
  /** A reap has reached the root while it lived: its exit since then is no longer its own. */
  readonly forcedReapAttempted?: boolean
}

export type ProviderProcessClosePolicy = {
  gracefulExitMs: number
  forcedExitMs: number
  immediateTerm?: boolean
  /** A root that leaves on its own after its stdin ends, with no forced reap ever on its tree, is
   *  the close: no claim is made about its descendants, and no post-exit reap runs. */
  selfExitIsClose?: boolean
}

export type ProviderProcessCloseInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  rootVerdict: () => DescendantTreeVerdict
  policy: ProviderProcessClosePolicy
  tree?: ProviderProcessTree
  terminateTree: () => Promise<ProviderProcessTeardownVerdict>
}

export type ProviderProcessCloseResult = {
  root: DescendantTreeVerdict
  /** Null when this close made no observation of the descendants. */
  tree: DescendantTreeVerdict | null
  /** Set when `selfExitIsClose` decided the close. */
  selfExit?: true
}

export const ROOT_ONLY_GRACEFUL_EXIT_MS = 1_500
const ROOT_ONLY_FORCED_EXIT_MS = 1_000

/** Default for providers without a descendant reaper: end stdin, wait, then the fallback teardown. */
export function rootOnlyProviderClosePolicy(dedicatedGroup: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: dedicatedGroup ? PROVIDER_STDIN_END_GRACE_MS : ROOT_ONLY_GRACEFUL_EXIT_MS,
    forcedExitMs: ROOT_ONLY_FORCED_EXIT_MS
  }
}

/** A root-only close is done once the root is gone; an unproven tree is reported, not retried. */
export function acceptProviderRootExit(result: ProviderProcessCloseResult): boolean {
  return result.root === 'exited'
}

/** Existing Windows root/tree policy; POSIX groups are owned by the managed handle. */
export async function closeProviderProcess(
  input: ProviderProcessCloseInput
): Promise<ProviderProcessCloseResult> {
  const { child, policy, tree } = input
  if (tree) {
    await tree.capture()
  }
  try {
    child.stdin?.end()
  } catch {
    // A broken pipe still owes the reap.
  }
  let reaped = false
  let fallbackTree: DescendantTreeVerdict | null = null
  if (input.rootVerdict() !== 'exited') {
    await waitForProcessExitUntil(input.exitPromise, policy.gracefulExitMs)
    if (input.rootVerdict() !== 'exited') {
      reaped = true
      await tree?.refresh?.()
      if (tree) {
        await tree.reap()
      } else {
        fallbackTree = await input.terminateTree()
      }
      await waitForProcessExitUntil(input.exitPromise, policy.forcedExitMs)
    }
  }
  if (
    policy.selfExitIsClose &&
    !reaped &&
    !tree?.forcedReapAttempted &&
    input.rootVerdict() === 'exited'
  ) {
    return { root: 'exited', tree: tree ? tree.treeVerdict : null, selfExit: true }
  }
  if (!reaped && input.rootVerdict() === 'exited' && tree && tree.treeVerdict !== 'exited') {
    await tree.reap()
  }
  return { root: input.rootVerdict(), tree: tree ? tree.treeVerdict : fallbackTree }
}

export type ProviderProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
}

export type ManagedProviderProcess = {
  child: PipedChildProcess
  dedicatedGroup: boolean
  /** The spawn failed before a process existed: absence is proven, but no exit was observed. */
  readonly processless: boolean
  /** `exited` covers a processless child too; use `rootExitObserved` for "a real process exited". */
  readonly rootVerdict: DescendantTreeVerdict
  /** A process that existed was seen to exit; never true for a processless child. */
  readonly rootExitObserved: boolean
  /** The last close that ran the ladder; the already-exited answer only when none did. */
  readonly lastCloseResult: ProviderProcessCloseResult | null
  readonly exitPromise: Promise<void>
  readonly completion: Promise<ProviderProcessExit>
  readonly settled: boolean
  onSettled(listener: (exit: ProviderProcessExit) => void): void
  verifyWriters(budget?: ProviderCleanupBudget): Promise<ProviderResourceResult>
  /** The configured executable was missing at spawn. */
  readonly executableMissing: boolean
  /** The last 8 KiB of stderr, which the managed process drains so the child never blocks on it. */
  stderrTail(): string
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<ProviderProcessTeardownVerdict>
  attachTree(tree: ProviderProcessTree): void
  close(tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult>
}

export type ManagedProviderProcessOptions = ProviderProcessOutputOptions & {
  site: string
  resource?: ProviderResource
  windowsDetached?: boolean
  /** Defaults to the root-only policy; only a provider with its own reaper overrides it. */
  policy?: (dedicatedGroup: boolean) => ProviderProcessClosePolicy
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Defaults to "the root is gone". */
  acceptClose?: (result: ProviderProcessCloseResult) => boolean
}
