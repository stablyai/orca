// What counts as a shared workspace when deciding whose credentials a session may carry. One definition, used
// by secrets, agent accounts, the firewall and the egress proxy. Workspaces are never shared with teammates, so
// the only case left is an owner transfer.
import type { SandboxRow } from './store'

/**
 * A workspace whose owner was ever changed is in shared mode for good. Its disk was set up by
 * someone else, and whatever they left there (hooks, dotfiles, scripts) runs on every later boot, so nothing
 * personal to the new owner is ever attached. A fresh workspace is the way to use personal credentials.
 */
export function isSharedWorkspace(row: Pick<SandboxRow, 'ownership_transferred_at'>): boolean {
  return row.ownership_transferred_at != null
}
