import type { CliStatusResult } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeRpcSuccess } from './types'

const OPEN_POLL_MS = 250

export type DesktopOpenWait =
  | { kind: 'ready' }
  | { kind: 'wait' }
  | { kind: 'blocked' }
  | {
      kind: 'capped'
      message: string
      worktreeCount: number
      limit: number
    }
  | { kind: 'unresponsive' }

/** Decide whether `orca open` can return, must keep polling, or already has a countable failure. */
export function classifyDesktopOpenStatus(status: CliStatusResult): DesktopOpenWait {
  if (status.app.desktopWindowStatus === 'blocked') {
    return { kind: 'blocked' }
  }
  if (status.runtime.state === 'unresponsive') {
    return { kind: 'unresponsive' }
  }
  const hydration = status.runtime.worktreeHydration
  const windowReady = status.app.desktopWindowStatus === 'available'
  if (hydration && windowReady) {
    return {
      kind: 'capped',
      message: hydration.message,
      worktreeCount: hydration.worktreeCount,
      limit: hydration.limit
    }
  }
  if (windowReady) {
    return { kind: 'ready' }
  }
  return { kind: 'wait' }
}

export function refuseBlockedDesktopActivation(status: CliStatusResult): void {
  const decision = classifyDesktopOpenStatus(status)
  if (decision.kind === 'blocked') {
    throwDesktopOpenFailure(decision)
  }
}

function throwDesktopOpenFailure(decision: DesktopOpenWait): void {
  if (decision.kind === 'blocked') {
    throw new RuntimeClientError(
      'desktop_activation_blocked',
      'Orca is running headlessly, but it cannot open a desktop window safely because the persistent terminal provider is unavailable. Quit Orca normally and start the app again; do not use open -n.'
    )
  }
  if (decision.kind === 'unresponsive') {
    throw new RuntimeClientError(
      'runtime_unresponsive',
      'Orca is running, but its runtime is not accepting commands.'
    )
  }
  if (decision.kind === 'capped') {
    throw new RuntimeClientError('worktree_hydration_capped', decision.message, {
      worktreeCount: decision.worktreeCount,
      limit: decision.limit
    })
  }
}

/** Poll until the desktop window is up. A capped catalog fails with the count, after the window exists. */
export async function waitForDesktopOpen(
  initial: RuntimeRpcSuccess<CliStatusResult>,
  timeoutMs: number,
  readStatus: () => Promise<RuntimeRpcSuccess<CliStatusResult>>
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const initialDecision = classifyDesktopOpenStatus(initial.result)
  if (initialDecision.kind !== 'wait' && initialDecision.kind !== 'ready') {
    throwDesktopOpenFailure(initialDecision)
  }
  if (initialDecision.kind === 'ready') {
    return initial
  }

  const startedAt = Date.now()
  let capped: { message: string; worktreeCount: number; limit: number } | null = null
  while (Date.now() - startedAt < timeoutMs) {
    const status = await readStatus()
    const decision = classifyDesktopOpenStatus(status.result)
    if (decision.kind === 'ready') {
      return status
    }
    if (decision.kind !== 'wait') {
      throwDesktopOpenFailure(decision)
    }
    if (status.result.runtime.worktreeHydration) {
      capped = status.result.runtime.worktreeHydration
    }
    await new Promise<void>((resolve) => setTimeout(resolve, OPEN_POLL_MS))
  }

  if (capped) {
    throw new RuntimeClientError('worktree_hydration_capped', capped.message, {
      worktreeCount: capped.worktreeCount,
      limit: capped.limit
    })
  }
  throw new RuntimeClientError(
    'runtime_open_timeout',
    'Timed out waiting for an Orca desktop window. The runtime may still be running headlessly.'
  )
}
