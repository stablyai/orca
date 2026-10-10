import { describe, expect, it } from 'vitest'
import { isVerifiedOpenCodeLegacyModelVersion } from './opencode-model-version-policy'

describe('verified legacy OpenCode model versions', () => {
  it.each(['1.18.30', '1.18.32', '1.18.35'])(
    'supports the verified model semantics of %s',
    (version) => {
      expect(isVerifiedOpenCodeLegacyModelVersion(version)).toBe(true)
    }
  )

  it.each([null, undefined, '1.18.29', '1.18.31', '1.18.33', '1.18.32-beta', '2.0.16'])(
    'keeps unverified version %s unsupported',
    (version) => {
      expect(isVerifiedOpenCodeLegacyModelVersion(version)).toBe(false)
    }
  )
})
