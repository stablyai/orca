import { RuntimeClientError } from './runtime-client-error'

const SOCKET_START_FAILURE_BACKOFF_MS = 10_000
const SUPERSEDED_STARTUP_MESSAGE = 'native macOS provider startup was superseded'

type StoredSocketStartFailure = {
  expiresAt: number
  code: string
  message: string
}

export class NativeProviderStartupFailureBackoff {
  private recentFailure: StoredSocketStartFailure | null = null

  get(now = Date.now()): RuntimeClientError | null {
    if (!this.recentFailure) {
      return null
    }
    if (now >= this.recentFailure.expiresAt) {
      this.clear()
      return null
    }
    return new RuntimeClientError(this.recentFailure.code, this.recentFailure.message)
  }

  remember(error: RuntimeClientError, now = Date.now()): void {
    this.recentFailure = {
      expiresAt: now + SOCKET_START_FAILURE_BACKOFF_MS,
      code: error.code,
      message: error.message
    }
  }

  clear(): void {
    this.recentFailure = null
  }

  normalize(error: unknown): RuntimeClientError {
    if (error instanceof RuntimeClientError) {
      return error
    }
    return new RuntimeClientError(
      'accessibility_error',
      error instanceof Error ? error.message : String(error)
    )
  }

  shouldRemember(error: RuntimeClientError): boolean {
    return error.message !== SUPERSEDED_STARTUP_MESSAGE
  }
}
