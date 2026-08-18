type TargetedReattach = Readonly<{ start: () => void }>

// Why bounded: every rejected frame asks for its own attach round trip, so a relay that starts
// rejecting across many PTYs at once fans out one concurrent reattach per PTY. The bulk reconnect
// path caps the identical work, and each attach also costs a lease read and a lease write.
export class SshPtyTargetedReattachQueue {
  private readonly running = new Map<string, TargetedReattach>()
  private readonly waiting: TargetedReattach[] = []
  private active = 0

  constructor(private readonly maxConcurrency: number) {}

  has(key: string): boolean {
    return this.running.has(key)
  }

  run(key: string, task: () => Promise<boolean>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const entry: TargetedReattach = {
        start: () => {
          this.active++
          task().then(
            (recovered) => {
              this.settle(key, entry)
              resolve(recovered)
            },
            (error: unknown) => {
              this.settle(key, entry)
              reject(error instanceof Error ? error : new Error(String(error)))
            }
          )
        }
      }
      this.running.set(key, entry)
      if (this.active < this.maxConcurrency) {
        entry.start()
        return
      }
      this.waiting.push(entry)
    })
  }

  // Why queued entries are dropped rather than started: each one is keyed to the provider generation
  // the teardown just ended, so running it would attach onto a mux that is already gone.
  clear(): void {
    this.waiting.length = 0
    this.running.clear()
  }

  private settle(key: string, entry: TargetedReattach): void {
    if (this.running.get(key) === entry) {
      this.running.delete(key)
    }
    this.active--
    this.waiting.shift()?.start()
  }
}
