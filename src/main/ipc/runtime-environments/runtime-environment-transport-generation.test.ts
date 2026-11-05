import { describe, expect, it } from 'vitest'
import {
  _getRuntimeEnvironmentTransportGenerationCacheSize,
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'

describe('runtime environment transport generations', () => {
  it('bounds retired environment generations', () => {
    for (let index = 0; index < 600; index += 1) {
      advanceRuntimeEnvironmentTransportGeneration(`retired-environment-${index}`)
    }

    expect(_getRuntimeEnvironmentTransportGenerationCacheSize()).toBeLessThanOrEqual(512)
  })

  it('does not reopen a fence after an environment key is evicted', () => {
    advanceRuntimeEnvironmentTransportGeneration('reused-environment')
    const beforeEviction = getRuntimeEnvironmentTransportGeneration('reused-environment')
    for (let index = 0; index < 1_100; index += 1) {
      advanceRuntimeEnvironmentTransportGeneration(`churn-${index}`)
    }
    advanceRuntimeEnvironmentTransportGeneration('reused-environment')

    expect(getRuntimeEnvironmentTransportGeneration('reused-environment')).toBeGreaterThan(
      beforeEviction
    )
  })
})
