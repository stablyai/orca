import { afterEach, describe, expect, it, vi } from 'vitest'
import { installOrcadFeatureReadiness, rpcMethodFeatureWait } from './orcad-readiness'

// No local readiness reset: the shared vitest setup must restore it (asserted below).
afterEach(() => {
  vi.useRealTimers()
})

describe('OrcadFeatureReadiness', () => {
  it('adds no await for open or undeclared features, so ungated dispatch starts synchronously', () => {
    expect(rpcMethodFeatureWait([])).toBeNull()
    expect(rpcMethodFeatureWait(['accounts'])).toBeNull()
    const readiness = installOrcadFeatureReadiness()
    expect(rpcMethodFeatureWait([])).toBeNull()
    readiness.open('accounts')
    expect(rpcMethodFeatureWait(['accounts'])).toBeNull()
  })

  // The shared setup resets after every test; these two run in order in one worker.
})
