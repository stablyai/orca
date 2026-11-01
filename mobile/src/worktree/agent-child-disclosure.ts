import type { AgentDotState } from './agent-row-display'

// Mirrors desktop worktree-card-idle-child-agents: a lone idle child costs the same row as its group.
const MIN_IDLE_CHILDREN_TO_GROUP = 2

export function partitionIdleChildren<T extends { dotState: AgentDotState }>(
  children: readonly T[]
): { activeChildren: T[]; idleChildren: T[] } {
  const idleChildren = children.filter((child) => child.dotState === 'idle')
  if (idleChildren.length < MIN_IDLE_CHILDREN_TO_GROUP) {
    return { activeChildren: [...children], idleChildren: [] }
  }
  return {
    activeChildren: children.filter((child) => child.dotState !== 'idle'),
    idleChildren
  }
}

// Desktop SUMMARY_STATE_ORDER minus the quiet states (done, unverifiable, idle) a collapsed parent never signals.
const SIGNAL_STATE_ORDER: readonly AgentDotState[] = [
  'waiting',
  'blocked',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted'
]

/** The most urgent non-quiet child state, so a collapsed parent still shows live sub-agent work. */
export function collapsedChildrenSignalState(
  children: readonly { dotState: AgentDotState }[]
): AgentDotState | undefined {
  return SIGNAL_STATE_ORDER.find((state) => children.some((child) => child.dotState === state))
}

// Lists remount as the workspace list scrolls; keep disclosures for the session, bounded like desktop's cache.
const MAX_REMEMBERED_DISCLOSURES = 512
const openDisclosureKeys = new Set<string>()

export function isDisclosureOpen(key: string): boolean {
  return openDisclosureKeys.has(key)
}

export function toggleDisclosure(key: string): void {
  if (openDisclosureKeys.delete(key)) {
    return
  }
  openDisclosureKeys.add(key)
  if (openDisclosureKeys.size > MAX_REMEMBERED_DISCLOSURES) {
    const oldest = openDisclosureKeys.values().next().value
    if (oldest !== undefined) {
      openDisclosureKeys.delete(oldest)
    }
  }
}

export function clearDisclosuresForTests(): void {
  openDisclosureKeys.clear()
}
