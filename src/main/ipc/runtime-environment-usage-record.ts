import { markEnvironmentUsed } from '../../shared/runtime-environment-store'

/**
 * Records `lastUsedAt` for callers that cannot report a failure to anyone.
 *
 * Why: subscription frames arrive on a websocket callback with no promise to reject and no
 * caller to observe the result, so a throw from the store unwinds into the socket emitter and
 * kills the main process. `orca environment rm` makes that routine — it edits the store behind
 * the running app's back, so every later response resolves an environment that is gone. Usage
 * bookkeeping has no consumer, so nothing here is worth an exception. Awaited request paths keep
 * calling `markEnvironmentUsed` directly: there the rejection is observable and correct.
 */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string } = {}
): void {
  try {
    markEnvironmentUsed(userDataPath, selector, args)
  } catch (error) {
    console.warn(
      `Skipped last-used bookkeeping for runtime environment ${selector}:`,
      error instanceof Error ? error.message : error
    )
  }
}
