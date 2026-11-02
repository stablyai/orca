import type { ConnectionState } from './types'

type RelaySessionStateSource = {
  getState(): ConnectionState
  onStateChange(listener: (state: ConnectionState) => void): () => void
}

// Requests issued before a relay session connects wait here until it connects, fails, times out or is retired.
export class MobileRelayConnectWaiters {
  private readonly releases = new Set<() => void>()

  constructor(private readonly session: RelaySessionStateSource) {}

  wait(timeoutMs: number): Promise<void> {
    if (this.session.getState() === 'connected') {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const settle = (error: Error | null): void => {
        clearTimeout(timer)
        unsubscribe()
        this.releases.delete(release)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const release = () => settle(new Error('relay session closed'))
      this.releases.add(release)
      const unsubscribe = this.session.onStateChange((next) => {
        if (next === 'connected') {
          settle(null)
        } else if (next === 'disconnected' || next === 'auth-failed') {
          settle(new Error(`relay session ${next}`))
        }
      })
      const timer = setTimeout(
        () => settle(new Error('relay session connection timed out')),
        timeoutMs
      )
    })
  }

  // A failed session already published disconnected, so requests issued since are still waiting; retiring it must release them to the replacement.
  releaseAll(): void {
    for (const release of this.releases) {
      release()
    }
  }
}
