export class StructuredAgentSessionRestartRestoreGate {
  private current: Promise<void> | null = null

  run(restore: () => Promise<void>): Promise<void> {
    // Serialize batches without discarding a later batch's session IDs.
    const run = (this.current ?? Promise.resolve()).then(restore)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.current = tail
    void tail.then(() => {
      if (this.current === tail) {
        this.current = null
      }
    })
    return run
  }
}
