export class QuitTeardownStartGate {
  private started = false

  tryStart(event: { preventDefault(): void }): boolean {
    event.preventDefault()
    if (this.started) {
      return false
    }
    this.started = true
    return true
  }

  hasStarted(): boolean {
    return this.started
  }

  resetForTests(): void {
    this.started = false
  }
}

// Why shared, not per-caller: subsystems fence new work on "the committed quit has begun", and a
// second instance would answer no while the real teardown is already draining what it snapshotted.
export const quitTeardownStartGate = new QuitTeardownStartGate()
