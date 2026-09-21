import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayControlRequests } from './relay-control-requests'

afterEach(() => vi.useRealTimers())
describe('final source request retirement notification', () => {
  it.each(['reply', 'denial', 'timeout', 'send-failed', 'closed'] as const)(
    'notifies final work completion after %s',
    async (outcome) => {
      vi.useFakeTimers()
      const changed = vi.fn()
      const requests = new RelayControlRequests(changed)
      const result = requests
        .confirmResume('req', 'basis', () => {
          if (outcome === 'send-failed') {
            throw new Error('send-failed')
          }
        })
        .catch((error: Error) => error.message)
      if (outcome === 'reply') {
        requests.resolveMessage({
          type: 'device-resume-confirmed',
          v: 1,
          reqId: 'req',
          currentVersion: 1,
          acceptedAs: 'current',
          renewed: true,
          resumeExpiresAt: 123_000
        })
      } else if (outcome === 'denial') {
        requests.resolveMessage({ type: 'control-error', reqId: 'req', code: 'denied' })
      } else if (outcome === 'timeout') {
        await vi.advanceTimersByTimeAsync(10_000)
      } else if (outcome === 'closed') {
        requests.rejectAll(new Error('closed'))
      }
      await result
      await vi.advanceTimersByTimeAsync(0)
      expect(requests.size).toBe(0)
      expect(changed).toHaveBeenCalledOnce()
    }
  )
})
