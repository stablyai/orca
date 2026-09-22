export class StructuredAgentSessionRestartRestoreGate {
  private current: Promise<void> | null = null

  run(restore: () => Promise<void>): Promise<void> {
    if (this.current) {
      return this.current
    }
    const tracked = restore().catch((error: unknown) => {
      if (this.current === tracked) {
        this.current = null
      }
      throw error
    })
    this.current = tracked
    return tracked
  }
}
