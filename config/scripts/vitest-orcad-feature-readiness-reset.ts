// A startOrcad test that fails partway must not leave latches closed: later tests in the worker would wait 10 s.
import { afterEach } from 'vitest'
import { _resetOrcadFeatureReadinessForTests } from '../../src/main/runtime/rpc/orcad-feature-readiness'

afterEach(() => {
  _resetOrcadFeatureReadinessForTests()
})
