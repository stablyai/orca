export class TerminalSettingsModalHandoff {
  private pending = false

  request(closeModal: () => void): void {
    this.pending = true
    closeModal()
  }

  complete(openSettings: () => void): boolean {
    if (!this.pending) {
      return false
    }
    this.pending = false
    openSettings()
    return true
  }
}
