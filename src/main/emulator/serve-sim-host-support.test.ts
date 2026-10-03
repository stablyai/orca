import { describe, expect, it } from 'vitest'
import { describeServeSimHelperFailure } from './serve-sim-host-support'

describe('describeServeSimHelperFailure', () => {
  it('rewrites dyld symbol failures and keeps the raw output', () => {
    const raw = 'Helper failed: dyld[1]: Symbol not found: (_$s10Foundation11JSONDecoderC6decode)'
    const described = describeServeSimHelperFailure(raw)
    expect(described).toContain('Update macOS')
    expect(described).toContain(raw)
  })

  it('leaves unrelated failures alone', () => {
    expect(describeServeSimHelperFailure('Port 3100 already in use')).toBeNull()
  })
})
