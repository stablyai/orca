export class HostPublicationEpochs {
  private readonly states = new Map<string, { epoch: number; removed: boolean }>()

  current(hostId: string): number {
    return this.states.get(hostId)?.epoch ?? 0
  }

  beginPairing(hostId: string): number {
    const next = this.current(hostId) + 1
    this.states.set(hostId, { epoch: next, removed: false })
    return next
  }

  beginRemoval(hostId: string): number {
    const next = this.current(hostId) + 1
    this.states.set(hostId, { epoch: next, removed: true })
    return next
  }

  isRemoved(hostId: string): boolean {
    return this.states.get(hostId)?.removed ?? false
  }

  resetForTests(): void {
    this.states.clear()
  }
}
