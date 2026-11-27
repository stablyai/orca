import { expect, it } from 'vitest'
import {
  ExternalAutomationProbeCancelledError,
  ExternalAutomationProbeScheduler
} from './external-automation-probe-scheduler'

it('runs a fresh probe for a key whose cancelled provider is still settling', async () => {
  const scheduler = new ExternalAutomationProbeScheduler({ concurrency: 2 })
  const release = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const job = { key: 'local|openclaw', scopeKey: 'local' }
  const abandoned = scheduler.schedule({
    ...job,
    run: () => {
      started.resolve()
      return release.promise
    }
  })
  await started.promise
  scheduler.retainScopes([])
  await expect(abandoned).rejects.toBeInstanceOf(ExternalAutomationProbeCancelledError)

  const current = scheduler.schedule({ ...job, run: async () => 'fresh' })
  release.resolve('stale')
  await expect(current).resolves.toBe('fresh')
})
