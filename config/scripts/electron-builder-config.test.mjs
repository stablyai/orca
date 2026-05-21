import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

describe('electron-builder config', () => {
  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })
})
