import { beforeEach, expect, it, vi } from 'vitest'
import { adoptStablePane } from './adopt-stable'
import { getProvider, getProviderForPty } from '../provider/registry'
import { attachStablePaneOwner, resolveStablePaneOwner } from './stable-owner'

vi.mock('../provider/registry', () => ({ getProvider: vi.fn(), getProviderForPty: vi.fn() }))
vi.mock('./stable-owner', () => ({
  attachStablePaneOwner: vi.fn(),
  resolveStablePaneOwner: vi.fn(),
  stablePaneAdoptionsByOwnerKey: new Map()
}))
const args = {
  cols: 80,
  rows: 24,
  worktreeId: 'folder',
  tabId: 'tab',
  leafId: '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
}
beforeEach(() => vi.clearAllMocks())

it('refuses an unavailable guest owner without attempting a host-native attach', async () => {
  const id = 'wsl:Ubuntu@@build@@terminal'
  vi.mocked(resolveStablePaneOwner).mockReturnValue({
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: id,
    hasPersistedBinding: true
  })
  vi.mocked(getProviderForPty).mockImplementation(() => {
    throw new Error('WSL terminal owner is not connected')
  })

  await expect(adoptStablePane(undefined, undefined, args)).rejects.toThrow('not connected')
  expect(getProviderForPty).toHaveBeenCalledWith(id)
  expect(getProvider).not.toHaveBeenCalled()
  expect(attachStablePaneOwner).not.toHaveBeenCalled()
})
