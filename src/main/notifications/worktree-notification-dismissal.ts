import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/**
 * Retire a worktree's announced notifications. The Electron process installs the
 * real implementation when it registers notification handlers; the headless orcad
 * build never imports it, so nothing in its graph reaches the electron package.
 */
export type WorktreeNotificationDismissal = (
  worktreeId: string,
  runtime?: OrcaRuntimeService
) => number

let dismissal: WorktreeNotificationDismissal | null = null

export function setWorktreeNotificationDismissal(
  implementation: WorktreeNotificationDismissal | null
): void {
  dismissal = implementation
}

/** Dismiss what the installed implementation retires; without one this is a no-op. */
export function dismissWorktreeNotifications(
  worktreeId: string,
  runtime?: OrcaRuntimeService
): number {
  return dismissal?.(worktreeId, runtime) ?? 0
}
