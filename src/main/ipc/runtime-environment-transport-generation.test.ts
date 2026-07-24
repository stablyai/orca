import { afterEach, describe, expect, it } from 'vitest'
import {
  _internals,
  advanceRuntimeEnvironmentTransportGeneration,
  retainRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'

afterEach(() => {
  _internals.resetForTest()
})

describe('runtime environment transport generations', () => {
  it('invalidates retained transports and releases their environment entry', () => {
    const lease = retainRuntimeEnvironmentTransportGeneration('environment-1')

    expect(lease.isCurrent()).toBe(true)
    advanceRuntimeEnvironmentTransportGeneration('environment-1')
    expect(lease.isCurrent()).toBe(false)

    lease.release()
    expect(_internals.trackedEnvironmentCountForTest()).toBe(0)
  })

  it('retains a shared environment entry until its final lease closes', () => {
    const first = retainRuntimeEnvironmentTransportGeneration('environment-1')
    const second = retainRuntimeEnvironmentTransportGeneration('environment-1')

    first.release()
    expect(second.isCurrent()).toBe(true)
    expect(_internals.trackedEnvironmentCountForTest()).toBe(1)

    second.release()
    expect(_internals.trackedEnvironmentCountForTest()).toBe(0)
  })

  it('does not accumulate tombstones under sequential unique-environment churn', () => {
    for (let index = 0; index < 10_000; index += 1) {
      const environmentId = `environment-${index}`
      const lease = retainRuntimeEnvironmentTransportGeneration(environmentId)
      advanceRuntimeEnvironmentTransportGeneration(environmentId)
      lease.release()
    }

    expect(_internals.trackedEnvironmentCountForTest()).toBe(0)
  })

  it('does not allocate tombstones when invalidating environments without transports', () => {
    for (let index = 0; index < 10_000; index += 1) {
      advanceRuntimeEnvironmentTransportGeneration(`environment-${index}`)
    }

    expect(_internals.trackedEnvironmentCountForTest()).toBe(0)
  })
})
