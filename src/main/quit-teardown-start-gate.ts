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
}
