import { markEnvironmentUsed } from '../../../shared/remote-runtime/host-store/runtime-environment-store'

/** Subscription callbacks cannot reject to a caller; usage writes must tolerate removed or unreadable environments. */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: Parameters<typeof markEnvironmentUsed>[2] = {}
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
