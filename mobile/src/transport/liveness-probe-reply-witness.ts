// Why: a reply proves the current uplink only if its request was written after the probe
// in flight; a superseded probe's or an earlier request's late reply predates the break.
export class LivenessProbeReplyWitness {
  private probeId: string | null = null
  private readonly laterRequestIds = new Set<string>()

  probeSent(id: string): void {
    this.probeId = id
    this.laterRequestIds.clear()
  }

  requestWritten(request: unknown): void {
    if (this.probeId !== null && typeof request === 'object' && request !== null) {
      const id: unknown = Reflect.get(request, 'id')
      if (typeof id === 'string') {
        this.laterRequestIds.add(id)
      }
    }
  }

  settles(responseId: string): boolean {
    if (responseId !== this.probeId && !this.laterRequestIds.has(responseId)) {
      return false
    }
    this.probeId = null
    this.laterRequestIds.clear()
    return true
  }
}
