const DEFAULT_RECONNECT_RETRY_DELAY_MS = 100
const MAX_RECONNECT_RETRY_DELAY_MS = 2_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class BrowserHostReconnectDelay {
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolve: (() => void) | null = null

  wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.timer = setTimeout(() => {
        this.timer = null
        this.resolve = null
        resolve()
      }, delayMs)
    })
  }

  release(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const resolve = this.resolve
    this.resolve = null
    resolve?.()
  }
}

export function resolveBrowserHostReconnectDelay(
  value: number | undefined,
  fallback = DEFAULT_RECONNECT_RETRY_DELAY_MS
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_TIMER_DELAY_MS) {
    throw new Error('Browser host reconnect delay is invalid')
  }
  return resolved
}

export function nextBrowserHostReconnectDelay(options: {
  baseDelayMs: number
  attempt: number
  remainingMs: number
  browserHostClientId: string
}): number {
  const exponent = Math.min(options.attempt, 30)
  const ceiling = Math.min(MAX_RECONNECT_RETRY_DELAY_MS, options.baseDelayMs * 2 ** exponent)
  const jitter = 0.5 + stableFraction(`${options.browserHostClientId}:${options.attempt}`) / 2
  return Math.max(1, Math.min(options.remainingMs, Math.floor(ceiling * jitter)))
}

function stableFraction(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) / 0xffffffff
}
