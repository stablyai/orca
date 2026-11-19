import type * as NodeFs from 'node:fs'
import { createRequire } from 'node:module'
import type * as NodePath from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual.win32, default: actual.win32 }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, realpathSync: () => 'R:\\s1' }
})

import { resolve } from './plugin-test-hooks'

it('lets Node resolve bundled runtime imports outside the plugin drive', async () => {
  const parentURL = new URL(
    '../../../../resources/plugins/declarative/orca-testing.mjs',
    import.meta.url
  ).href
  const resolved = await resolve('./orca-runtime.mjs', { parentURL }, async (specifier) => ({
    url: pathToFileURL(createRequire(parentURL).resolve(specifier)).href
  }))
  expect(resolved).toEqual({
    url: new URL('../../../../resources/plugins/declarative/orca-runtime.mjs', import.meta.url).href
  })
})
