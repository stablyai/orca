// What counts as a shared workspace when deciding whose credentials a session may carry. One
// definition, used by secrets, agent accounts, the egress proxy and the member git rules.
import type { SandboxRow } from './store'

/**
 * D13: a workspace shared with teammates never uses a personal account. Fails closed: only a row
 * known to be private counts as unshared.
 * OWNER-TRANSFER: a workspace whose owner was ever changed is in shared mode for good. Its disk was
 * set up by someone else, and whatever they left there runs when the new owner uses it, so nothing
 * personal to the new owner is ever attached. A fresh workspace is the way to use personal credentials.
 */
export function isSharedWorkspace(row: Pick<SandboxRow, 'visibility' | 'ownership_transferred_at'>): boolean {
  return row.visibility !== 'private' || row.ownership_transferred_at != null
}
