type AdmittedUnit = { run: () => Promise<void> }

/** Capped foreground cohorts alternate with one ready maintenance unit; no pass owns the writer. */
export class JournalNativeService {
  private readonly foreground: AdmittedUnit[] = []
  private readonly maintenance: AdmittedUnit[] = []
  private running: Promise<void> | undefined
  private closing = false

  admit<T>(run: () => Promise<T>, maintenance = false): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('journal native service is closing'))
    }
    const settled = Promise.withResolvers<T>()
    const queue = maintenance ? this.maintenance : this.foreground
    queue.push({
      run: async () => {
        try {
          settled.resolve(await run())
        } catch (error) {
          settled.reject(error)
        }
      }
    })
    this.start()
    return settled.promise
  }

  async close(): Promise<void> {
    this.closing = true
    await this.running
  }

  private start(): void {
    this.running ??= Promise.resolve()
      .then(() => this.serve())
      .finally(() => {
        this.running = undefined
        if (this.foreground.length || this.maintenance.length) {
          this.start()
        }
      })
  }

  private async serve(): Promise<void> {
    while (this.foreground.length || this.maintenance.length) {
      const count = Math.min(this.foreground.length, 16)
      const started = performance.now()
      for (let index = 0; index < count; index++) {
        await this.foreground.shift()?.run()
        if (performance.now() - started >= 8) {
          break
        }
      }
      await this.maintenance.shift()?.run()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}
