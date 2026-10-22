// One pending linger at a time: re-arming while armed keeps the first deadline,
// so repeated "no demand" reconciles cannot postpone the close forever.
export class RelayLingerTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  arm(delayMs: number, onExpire: () => void): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      onExpire()
    }, delayMs)
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
