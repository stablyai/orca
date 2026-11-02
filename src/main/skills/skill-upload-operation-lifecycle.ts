export class SkillUploadOperationLifecycle {
  private beginTurn = Promise.resolve()
  private operationsSettled = Promise.resolve()
  private resolveOperationsSettled: (() => void) | null = null
  private inFlight = 0

  get hasInFlight(): boolean {
    return this.inFlight > 0
  }

  enter(assertAvailable: () => void): () => void {
    assertAvailable()
    if (this.inFlight === 0) {
      this.operationsSettled = new Promise<void>((resolve) => {
        this.resolveOperationsSettled = resolve
      })
    }
    this.inFlight += 1
    let left = false
    return () => {
      if (left) {
        return
      }
      left = true
      this.inFlight -= 1
      if (this.inFlight === 0) {
        const resolve = this.resolveOperationsSettled
        this.resolveOperationsSettled = null
        resolve?.()
      }
    }
  }

  async enterBegin(assertAvailable: () => void): Promise<() => void> {
    const leaveOperation = this.enter(assertAvailable)
    const previousTurn = this.beginTurn
    let releaseTurn!: () => void
    this.beginTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    await previousTurn
    try {
      assertAvailable()
    } catch (error) {
      releaseTurn()
      leaveOperation()
      throw error
    }
    return () => {
      releaseTurn()
      leaveOperation()
    }
  }

  async settle(): Promise<void> {
    await this.operationsSettled
  }
}
