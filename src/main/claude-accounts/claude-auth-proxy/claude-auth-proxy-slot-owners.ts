/**
 * Which PTY a slot belongs to. The proxy map only knows the billed account.
 * An unbound slot is a launch that has not committed yet; status keeps it for a short grace,
 * then drops it. A bound slot stays while that PTY is still registered or still in the pane registry.
 */

export const CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS = 30_000

type ClaudeAuthProxySlotOwner = {
  ptyId: string | null
  allocatedAt: number
}

const owners = new Map<string, ClaudeAuthProxySlotOwner>()

export function noteClaudeAuthProxySlotAllocated(slot: string, now = Date.now()): void {
  const current = owners.get(slot)
  owners.set(slot, {
    ptyId: current?.ptyId ?? null,
    allocatedAt: current?.allocatedAt ?? now
  })
}

export function bindClaudeAuthProxySlotToPty(slot: string, ptyId: string, now = Date.now()): void {
  const current = owners.get(slot)
  owners.set(slot, { ptyId, allocatedAt: current?.allocatedAt ?? now })
}

export function claudeAuthProxySlotOwner(
  slot: string
): { ptyId: string | null; allocatedAt: number } | null {
  const owner = owners.get(slot)
  return owner ? { ptyId: owner.ptyId, allocatedAt: owner.allocatedAt } : null
}

/** Removes and returns every slot bound to this PTY. The caller releases them. */
export function takeClaudeAuthProxySlotsForPty(ptyId: string): string[] {
  const slots: string[] = []
  for (const [slot, owner] of owners) {
    if (owner.ptyId === ptyId) {
      owners.delete(slot)
      slots.push(slot)
    }
  }
  return slots
}

export function forgetClaudeAuthProxySlotOwner(slot: string): void {
  owners.delete(slot)
}

/**
 * True when status should drop the slot. A pane record that names the slot is kept by the caller:
 * the registry can exist before the PTY is registered.
 */
export function claudeAuthProxySlotShouldPrune(
  slot: string,
  livePtyIds: ReadonlySet<string>,
  now: number,
  graceMs = CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS
): boolean {
  const owner = owners.get(slot)
  if (!owner) {
    return true
  }
  if (owner.ptyId) {
    return !livePtyIds.has(owner.ptyId)
  }
  return now - owner.allocatedAt > graceMs
}

export function resetClaudeAuthProxySlotOwners(): void {
  owners.clear()
}
