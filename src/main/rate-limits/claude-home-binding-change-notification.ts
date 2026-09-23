/**
 * One seam for "this group's bound CLAUDE_CONFIG_DIR may now resolve elsewhere, or nowhere".
 *
 * Why module-level rather than a constructor dependency: group mutations arrive on two paths that
 * are wired in different places — `RuntimeProjectGroupController` (the RPC surface a paired client
 * reaches) and the `projectGroups:*` IPC handlers (the path a plain local Orca takes, and the only
 * configuration that renders bound-group rows at all). The IPC registration has no handle on the
 * rate-limit service, exactly as `repos-changed-notification.ts` has none on the runtime.
 */
type ClaudeHomeBindingChangeNotifier = (groupId: string) => void

let notifier: ClaudeHomeBindingChangeNotifier | null = null

export function setClaudeHomeBindingChangeNotifier(next: ClaudeHomeBindingChangeNotifier): void {
  notifier = next
}

export function notifyClaudeHomeBindingChanged(groupId: string): void {
  try {
    notifier?.(groupId)
  } catch (err) {
    // Why: dropping a stale usage row must never fail the group edit the user actually asked for.
    console.error('[rate-limits] failed to evict bound Claude home usage', err)
  }
}
