/** Host-local input gate restored from durable ownership-transfer state. */
export class PtyOwnershipTransferInputFence {
  private readonly terminalIds = new Set<string>()

  set(terminalId: string, fenced: boolean, terminalExists: boolean): void {
    if (!fenced) {
      this.terminalIds.delete(terminalId)
    } else if (terminalExists) {
      this.terminalIds.add(terminalId)
    }
  }

  permits(terminalId: string): boolean {
    return !this.terminalIds.has(terminalId)
  }

  remove(terminalId: string): void {
    this.terminalIds.delete(terminalId)
  }

  clear(): void {
    this.terminalIds.clear()
  }
}
