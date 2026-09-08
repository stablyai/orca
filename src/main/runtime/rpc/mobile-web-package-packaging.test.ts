import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('mobile web package packaging', () => {
  it('copies the verified build as a real resource on every desktop platform', () => {
    const config = require('../../../../config/electron-builder.config.cjs') as {
      mac?: { extraResources?: { from?: string; to?: string }[] }
      linux?: { extraResources?: { from?: string; to?: string }[] }
      win?: { extraResources?: { from?: string; to?: string }[] }
    }
    const expected = { from: 'out/mobile-web-rnw', to: 'mobile-web' }

    expect(config.mac?.extraResources).toContainEqual(expected)
    expect(config.linux?.extraResources).toContainEqual(expected)
    expect(config.win?.extraResources).toContainEqual(expected)
  })
})
