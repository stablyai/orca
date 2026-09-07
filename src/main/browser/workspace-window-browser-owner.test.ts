import { expect, it, vi } from 'vitest'
import { PairedRuntimeBrowserClientHostRegistry } from './paired-runtime-browser-client-host-registry'
import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'

it('resolves existing page ownership only within its live runtime authority', async () => {
  const page = {
    browserPageId: 'page',
    workspaceId: 'folder',
    authorityRuntimeId: 'runtime-a'
  } as BrowserClientHostedPageInventory
  const composition = {
    start: vi.fn(),
    replaceAuthority: vi.fn(),
    retirePage: vi.fn(),
    close: vi.fn(async () => true),
    whenClosed: vi.fn(),
    findPage: vi.fn(() => page)
  }
  const registry = new PairedRuntimeBrowserClientHostRegistry({
    createComposition: () => composition
  })
  await registry.start({
    environmentId: 'env',
    pairingRevision: 1,
    authorityRuntimeId: 'runtime-a'
  })
  expect(registry.findPage('runtime-b', 'page')).toBeNull()
  expect(registry.findPage('runtime-a', 'page')).toBe(page)
  await registry.closeEnvironment('env')
  expect(registry.findPage('runtime-a', 'page')).toBeNull()
})
