// Use recorded timers so deadline tests assert requested delays without wall-clock waits.
type ArmedTimer = { delayMs: number; run: () => void; cancelled: boolean }

export function createTimerSeam() {
  const armed: ArmedTimer[] = []
  return {
    armed,
    setTimer: (run: () => void, delayMs: number): (() => void) => {
      const timer: ArmedTimer = { delayMs, run, cancelled: false }
      armed.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    fire: (): void => {
      // Fire a snapshot so timers armed by callbacks wait until the next round.
      const round = armed.slice()
      for (const timer of round) {
        if (!timer.cancelled) {
          timer.run()
        }
      }
    }
  }
}

export function live(timers: readonly ArmedTimer[]): ArmedTimer[] {
  return timers.filter((timer) => !timer.cancelled)
}
