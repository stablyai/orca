import { expect, it, vi } from 'vitest'
import { createHarness, notification, registration } from './push-dispatcher.test-fixture'

const devices = [
  {
    deviceId: 'phone-on-both',
    pushRegistration: registration({ registrationId: 'reg-both', tokenDigest: 'digest-both' })
  },
  {
    deviceId: 'phone-on-mirror',
    pushRegistration: registration({ registrationId: 'reg-mirror', tokenDigest: 'digest-mirror' })
  }
]

it('skips the phones a mirrored session’s execution host pushes itself', async () => {
  const resolveCoverage = vi.fn(async () => new Set(['digest-both']))
  const { dispatcher, sends } = createHarness({ devices, resolveCoverage })

  dispatcher.enqueue(notification({ executionHost: 'runtime:env-b' }))
  await vi.waitFor(() => expect(sends).toHaveLength(1))

  expect(resolveCoverage).toHaveBeenCalledWith('runtime:env-b', {
    tokenDigests: ['digest-both', 'digest-mirror'],
    source: 'agent-task-complete',
    agentState: 'done'
  })
  expect(sends.map((send) => send.registrationIds)).toEqual([['reg-mirror']])
})
