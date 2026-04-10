import type { BrowserWindow } from 'electron'
import type { RateLimitState, ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'

const DEFAULT_POLL_MS = 2 * 60 * 1000 // 2 minutes
const MIN_REFETCH_MS = 30 * 1000 // 30 seconds — debounce rapid refresh requests
const STALE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes — after this, stale data is dropped

export class RateLimitService {
  private state: RateLimitState = { claude: null, codex: null }
  private pollInterval: number = DEFAULT_POLL_MS
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFetchAt = 0
  private mainWindow: BrowserWindow | null = null
  private isFetching = false

  attach(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    mainWindow.on('closed', () => {
      if (this.mainWindow === mainWindow) {
        this.mainWindow = null
      }
    })
  }

  start(): void {
    // Fire initial fetch immediately on start
    void this.fetchAll()
    this.startTimer()
  }

  stop(): void {
    this.stopTimer()
    this.mainWindow = null
  }

  getState(): RateLimitState {
    return this.state
  }

  async refresh(): Promise<RateLimitState> {
    // Why: debounce rapid manual refreshes to avoid hammering APIs when the
    // user clicks refresh repeatedly. 30s minimum between fetches.
    const now = Date.now()
    if (now - this.lastFetchAt < MIN_REFETCH_MS) {
      return this.state
    }
    await this.fetchAll()
    return this.state
  }

  setPollingInterval(ms: number): void {
    this.pollInterval = Math.max(30_000, ms)
    if (this.timer) {
      this.stopTimer()
      this.startTimer()
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      void this.fetchAll()
    }, this.pollInterval)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async fetchAll(): Promise<void> {
    if (this.isFetching) {
      return
    }
    this.isFetching = true

    try {
      // Mark both providers as fetching while keeping previous data visible
      this.updateState({
        claude: this.withFetchingStatus(this.state.claude, 'claude'),
        codex: this.withFetchingStatus(this.state.codex, 'codex')
      })

      // Fetch both providers in parallel
      const [claude, codex] = await Promise.all([
        fetchClaudeRateLimits().catch(
          (err): ProviderRateLimits => ({
            provider: 'claude',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: err instanceof Error ? err.message : 'Unknown error',
            status: 'error'
          })
        ),
        fetchCodexRateLimits().catch(
          (err): ProviderRateLimits => ({
            provider: 'codex',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: err instanceof Error ? err.message : 'Unknown error',
            status: 'error'
          })
        )
      ])

      // Why: when a fetch fails but we have recent stale data, keep showing
      // the stale data rather than blanking out the display. This matches the
      // design doc's stale-data policy: data <10 min old is shown with a
      // dimmed indicator rather than replaced with an error state.
      this.updateState({
        claude: this.applyStalePolicy(claude, this.state.claude),
        codex: this.applyStalePolicy(codex, this.state.codex)
      })

      this.lastFetchAt = Date.now()
    } finally {
      this.isFetching = false
    }
  }

  private withFetchingStatus(
    current: ProviderRateLimits | null,
    provider: 'claude' | 'codex'
  ): ProviderRateLimits {
    if (!current) {
      return {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null,
        status: 'fetching'
      }
    }
    return { ...current, status: 'fetching' }
  }

  private applyStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    // Fresh data is fine — use it
    if (fresh.status === 'ok') {
      return fresh
    }

    // No previous data to fall back on
    if (!previous || previous.status !== 'ok') {
      return fresh
    }

    // Previous data is too old — don't show stale data
    if (Date.now() - previous.updatedAt > STALE_THRESHOLD_MS) {
      return fresh
    }

    // Show previous data with the new error, so the UI can render
    // stale data with a warning indicator
    return {
      ...previous,
      error: fresh.error,
      status: 'error'
    }
  }

  private updateState(next: RateLimitState): void {
    this.state = next
    this.pushToRenderer()
  }

  private pushToRenderer(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }
    this.mainWindow.webContents.send('rateLimits:update', this.state)
  }
}
