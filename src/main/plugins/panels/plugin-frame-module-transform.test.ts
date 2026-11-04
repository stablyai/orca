import { describe, expect, it } from 'vitest'
import { resolvePluginModuleSpecifier } from './plugin-frame-module-resolution'

const FILES = new Set([
  'src/panel.tsx',
  'src/util.ts',
  'src/list/index.tsx',
  'src/legacy.js',
  'src/data.json',
  'src/my file.ts'
])
const exists = async (path: string) => FILES.has(path)

describe('resolvePluginModuleSpecifier', () => {
  it('refuses bare packages, escapes and missing files', async () => {
    const refuse = (specifier: string) =>
      resolvePluginModuleSpecifier('src/panel.tsx', specifier, exists)
    await expect(refuse('react')).resolves.toMatchObject({
      kind: 'refuse',
      reason: expect.stringContaining('cannot import "react"')
    })
    await expect(refuse('../../secret')).resolves.toMatchObject({
      reason: expect.stringContaining('outside the plugin')
    })
    await expect(refuse('./nope')).resolves.toMatchObject({
      reason: expect.stringContaining('no such file')
    })
  })
})
