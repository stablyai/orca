import type { SshConnectionManager } from './ssh-connection-manager'

type ManagerBookkeeping = {
  connections: Map<string, unknown>
  connectingTargets: Map<string, symbol>
  pendingTargetOperations: Map<string, number>
  unconfirmedTargetTeardowns: Set<string>
  unclosedTransportsByTarget: Map<string, number>
}

function bookkeeping(manager: SshConnectionManager): ManagerBookkeeping {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are SshConnectionManager's own private fields; tests read them until T3/T8 expose readers.
  return manager as unknown as ManagerBookkeeping
}

/** Test-side reading of the target activity T3's hasTargetActivity will expose. */
export function managerTargetActive(manager: SshConnectionManager, targetId: string): boolean {
  const state = bookkeeping(manager)
  return (
    state.connections.has(targetId) ||
    state.connectingTargets.has(targetId) ||
    state.unconfirmedTargetTeardowns.has(targetId) ||
    state.pendingTargetOperations.has(targetId)
  )
}

/** Test-side reading of the closure proof T8's assertTargetTransportsClosed will expose. */
export function assertManagerTargetTransportsClosed(
  manager: SshConnectionManager,
  targetId: string
): void {
  if (
    managerTargetActive(manager, targetId) ||
    bookkeeping(manager).unclosedTransportsByTarget.has(targetId)
  ) {
    throw new Error('ssh_target_transport_closure_unproven')
  }
}

/** How many targets still owe a physical transport close. */
export function managerUnclosedTransportTargets(manager: SshConnectionManager): number {
  return bookkeeping(manager).unclosedTransportsByTarget.size
}
