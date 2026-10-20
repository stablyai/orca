import { describe, expect, it } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'

describe('repository add script capability', () => {
  it('is published by the runtime status and the static capability list', () => {
    expect(createRuntime().getStatus().capabilities).toContain('repository.add-script.v1')
    expect(RUNTIME_CAPABILITIES).toContain('repository.add-script.v1')
  })
})
