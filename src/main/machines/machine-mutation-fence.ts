/**
 * Orders provider reads against lifecycle results. A list or get that began before a machine's
 * latest create, wake, sleep, archive, delete or connect finished answers about an older machine,
 * so it must not overwrite that result, mark the machine gone, or retire its server.
 */
export class MachineMutationFence {
  private sequence = 0
  private readonly mutatedAt = new Map<string, number>()

  /** A token for a read starting now. */
  readStarted(): number {
    return this.sequence
  }

  mutated(providerKey: string, machineId: string): void {
    this.sequence += 1
    this.mutatedAt.set(`${providerKey}\0${machineId}`, this.sequence)
  }

  /** Whether a mutation of this machine finished after the read holding `token` began. */
  changedSince(providerKey: string, machineId: string, token: number): boolean {
    return (this.mutatedAt.get(`${providerKey}\0${machineId}`) ?? 0) > token
  }
}
