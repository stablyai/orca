const STATUS_CACHE_WRITE_DEBOUNCE_MS = 25

/** Coalesces bursty hook updates while flushing synchronously at lifecycle boundaries. */
export class RelayHookStatusCacheWriter {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly write: () => void) {}

  schedule(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.write()
    }, STATUS_CACHE_WRITE_DEBOUNCE_MS)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.write()
  }
}
