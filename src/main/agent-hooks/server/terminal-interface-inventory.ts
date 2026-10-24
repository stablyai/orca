import type { TerminalInterfaceTarget, Lease, Entry } from './terminal-interface-contracts'
import type { TerminalInterfaceObservation } from '../../../shared/terminal-interface-observation'

export function sameTerminalInterfaceTarget(
  left: TerminalInterfaceTarget,
  right: TerminalInterfaceTarget
): boolean {
  return (
    left.binding.ptyId === right.binding.ptyId &&
    left.binding.incarnationId === right.binding.incarnationId &&
    left.binding.terminalHandle === right.binding.terminalHandle &&
    left.binding.paneKey === right.binding.paneKey &&
    left.binding.worktreeId === right.binding.worktreeId &&
    left.generation === right.generation &&
    (right.launchToken === null || left.launchToken === right.launchToken)
  )
}

export function captureTerminalInterfaceSampleCurrentness(
  entries: ReadonlyMap<string, Entry>,
  lease: Lease,
  entry: Entry
): () => boolean {
  const target = entry.target
  const input = entry.input
  const fence = entry.fence
  return () =>
    entries.get(target.binding.ptyId) === entry &&
    entry.input === input &&
    entry.fence === fence &&
    !entry.target.blocked &&
    sameTerminalInterfaceTarget(target, entry.target) &&
    lease.driver
      .inventory(target.binding.ptyId)
      .some((candidate) => !candidate.blocked && sameTerminalInterfaceTarget(target, candidate))
}

export function syncTerminalInterfaceInventory(
  entries: Map<string, Entry>,
  lease: Lease,
  publish: (
    entry: Entry,
    state: TerminalInterfaceObservation['state'],
    basis: TerminalInterfaceObservation['basis']
  ) => void
): boolean {
  const keep = new Set<string>()
  let changed = false
  for (const target of lease.driver.inventory()) {
    keep.add(target.binding.ptyId)
    const previous = entries.get(target.binding.ptyId)
    if (previous && sameTerminalInterfaceTarget(previous.target, target)) {
      const changedBlock = previous.target.blocked !== target.blocked
      previous.target = target
      if (changedBlock) {
        previous.fence += 1
        previous.shellSince = previous.emptySince = null
        previous.due = 0
        if (target.blocked && previous.qualified) {
          publish(previous, 'unverifiable', 'process')
        }
      }
    } else {
      changed ||= previous?.observation != null
      entries.set(target.binding.ptyId, {
        target,
        observation: null,
        owner: null,
        input: 0,
        fence: 0,
        shellSince: null,
        emptySince: null,
        due: 0,
        pending: false,
        qualified: false,
        actual: false,
        executionLaunchToken: null,
        discoverUntil: performance.now() + 8000
      })
    }
  }
  for (const [id, entry] of entries) {
    if (!keep.has(id)) {
      changed ||= entry.observation !== null
      entries.delete(id)
    }
  }
  return changed
}
