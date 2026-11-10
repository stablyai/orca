const CATALOG_CREDIT_BYTES = 1024 * 1024

/** Roots retain one current producer page each; this owner bounds their combined posted payload. */
export class SessionSearchCatalogCredit {
  private bytes = 0
  private changed: Promise<void> = Promise.resolve()
  private signal: (() => void) | undefined
  async retain(size: number): Promise<() => void> {
    while (this.bytes && this.bytes + size > CATALOG_CREDIT_BYTES) {
      await this.changed
    }
    this.bytes += size
    if (!this.signal) {
      this.changed = new Promise((resolve) => {
        this.signal = resolve
      })
    }
    return () => {
      this.bytes -= size
      const signal = this.signal
      this.signal = undefined
      signal?.()
      if (this.bytes) {
        this.changed = new Promise((resolve) => {
          this.signal = resolve
        })
      }
    }
  }
}
