import { expect, it, vi } from 'vitest'

const existsSync = vi.hoisted(() =>
  vi.fn((path: string) => path === 'C:\\app\\out\\renderer\\web-index.html')
)

vi.mock('node:fs', () => ({ existsSync, statSync: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppPath: () => 'C:\\app\\out\\main' }
}))

import { getBundledWebClientRoot } from './main-process-serve'

it('uses the freshly built renderer web entry for development workspace windows', () => {
  expect(getBundledWebClientRoot()).toBe('C:\\app\\out\\renderer')
})
