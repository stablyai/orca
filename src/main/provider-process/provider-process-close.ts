import type { SpawnedProcess } from '@orca/process-host/process-spec'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './provider-process-supervisor'
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
  signalSupervisorOnClose?: boolean
  /** A root that leaves on its own after its stdin ends, with no forced reap ever on its tree, is
   *  the close: no claim is made about its descendants, and no post-exit reap runs. */
  selfExitIsClose?: boolean
}

export type ProviderProcessCloseInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  rootVerdict: () => DescendantTreeVerdict
  supervised?: boolean
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
export function rootOnlyProviderClosePolicy(supervised: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? PROVIDER_SUPERVISOR_MAX_STOP_MS : ROOT_ONLY_GRACEFUL_EXIT_MS,
    forcedExitMs: ROOT_ONLY_FORCED_EXIT_MS
  }
}

/** A root-only close is done once the root is gone; an unproven tree is reported, not retried. */
export function acceptProviderRootExit(result: ProviderProcessCloseResult): boolean {
  return result.root === 'exited'
}

/** The supervisor owns the POSIX signal ladder; its wrapper must outlive that ladder. */
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
  if (input.supervised && policy.signalSupervisorOnClose && input.rootVerdict() !== 'exited') {
    child.kill('SIGTERM')
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
