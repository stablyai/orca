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

// All subsystems must observe the same committed quit.
export const quitTeardownStartGate = new QuitTeardownStartGate()
