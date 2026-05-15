import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  asarUnpack?: string[]
}

describe('packaged CLI assets', () => {
  it('unpacks runtime dependencies used before Electron asar integration is available', () => {
    expect(builderConfig.asarUnpack).toEqual(
      expect.arrayContaining([
        'node_modules/ws/**',
        'node_modules/tweetnacl/**',
        'node_modules/zod/**'
      ])
    )
  })
})
