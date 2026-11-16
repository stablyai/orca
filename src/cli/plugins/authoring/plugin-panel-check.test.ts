import type * as NodePath from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual.win32, default: actual.win32 }
})

import { pluginStackLocation } from './plugin-panel-check'

it('skips stack frames on another drive and locates the plugin frame', () => {
  expect(
    pluginStackLocation(
      'R:\\s1',
      'Error: render failed\n    at C:\\orca\\orca-runtime.mjs:10:2\n    at R:\\s1\\src\\panel.tsx:4:7'
    )
  ).toBe('src/panel.tsx:4:7')
})
