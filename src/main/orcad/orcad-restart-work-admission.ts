/** In-memory exclusion between new host work and a bounded restart reservation. */
export class OrcadRestartWorkAdmission {
  private operations = 0
  private reservation: symbol | null = null
  private stopping = false

  get pending(): number { return this.operations }
  get reserved(): boolean { return this.reservation !== null }

  track<T>(run: () => Promise<T>): Promise<T> {
    this.operations++
    try {
      const operation = run()
      // Observe settlement without delaying the session queue's result behind its next task.
      void operation.then(
        () => { this.operations-- },
        () => { this.operations-- }
      )
      return operation
    } catch (error) {
      this.operations--
      return Promise.reject(error)
    }
  }

  admit<T>(run: () => Promise<T>): Promise<T> {
    if (!this.allowWork()) {
      return Promise.reject(new Error('The Orca server is updating. Retry when it reconnects.'))
    }
    return this.track(run)
  }

  /** A user action supersedes bookkeeping until shutdown actually commits. */
  allowWork(): boolean {
    if (this.stopping) {
      return false
    }
    this.reservation = null
    return true
  }

  closeForShutdown(owner: symbol): boolean {
    if (!this.owns(owner) || this.pending > 0) {
      return false
    }
    this.stopping = true
    return true
  }

  reserve(): symbol | null {
    if (this.reserved || this.pending > 0) {
      return null
    }
    const owner = Symbol('restart')
    this.reservation = owner
    return owner
  }

  owns(owner: symbol): boolean { return this.reservation === owner }
  release(owner: symbol): void {
    if (this.owns(owner) && !this.stopping) {
      this.reservation = null
    }
  }
}

export const orcadRestartWorkAdmission = new OrcadRestartWorkAdmission()
