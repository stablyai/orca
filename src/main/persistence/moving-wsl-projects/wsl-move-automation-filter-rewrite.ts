/**
 * The Automations page host filter after a WSL move. It selects one host or all of them, so it
 * cannot also cover the WSL host; a filter on this desktop would hide every automation the move
 * carried. Only then does it widen to All hosts, once: the ledgered run never repeats, so a
 * later choice of this desktop stays.
 */
import type { PersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { hostStableKey } from '../../../shared/automation-owner-key'

const DESKTOP_SELF_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})

/** The filter to persist, or null when it stays. */
export function wslMoveAutomationHostFilterUpdate(
  filter: PersistedAutomationHostFilter | undefined,
  movedAutomationCount: number
): PersistedAutomationHostFilter | null {
  return movedAutomationCount > 0 &&
    filter?.kind === 'host' &&
    filter.hostKey === DESKTOP_SELF_HOST_KEY
    ? { kind: 'all' }
    : null
}
