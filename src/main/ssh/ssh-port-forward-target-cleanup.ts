import type { SshPortForwardManager } from './ssh-port-forward'

/** Dispose only this target's forwards, awaiting physical close for every owned id. */
export async function removeSshPortForwardsForTarget(
  manager: SshPortForwardManager,
  connectionId: string
): Promise<void> {
  const ids = manager.listForwards(connectionId).map(({ id }) => id)
  for (const id of ids) {
    await manager.removeForwardAndWait(id)
  }
}
