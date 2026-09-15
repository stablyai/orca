import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('../web/preload-api/web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('../web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'shared-runtime' }),
  webRuntimeState: { activeEnvironment: { id: 'shared-runtime' } }
}))

import { createWebUiApi } from '../web/preload-api/web-ui-api'
import { UI_STORAGE_KEY } from '../web/preload-api/web-storage'

class WindowStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installStorage(storage: Storage): void {
  vi.stubGlobal('window', { localStorage: storage })
}

describe('window navigation isolation', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
    callRuntimeResult.mockResolvedValue({ ui: getDefaultUIState() })
  })

  it('keeps each window project navigation local while sharing runtime calls', async () => {
    const firstStorage = new WindowStorage()
    const secondStorage = new WindowStorage()

    installStorage(firstStorage)
    const first = createWebUiApi()
    await first.set({
      activeView: 'terminal',
      lastActiveRepoId: 'repo-a',
      lastActiveWorktreeId: 'a'
    })

    installStorage(secondStorage)
    const second = createWebUiApi()
    await second.set({ activeView: 'tasks', lastActiveRepoId: 'repo-b', lastActiveWorktreeId: 'b' })

    expect(JSON.parse(firstStorage.getItem(UI_STORAGE_KEY)!)).toMatchObject({
      activeView: 'terminal',
      lastActiveRepoId: 'repo-a',
      lastActiveWorktreeId: 'a'
    })
    expect(JSON.parse(secondStorage.getItem(UI_STORAGE_KEY)!)).toMatchObject({
      activeView: 'tasks',
      lastActiveRepoId: 'repo-b',
      lastActiveWorktreeId: 'b'
    })
    expect(callRuntimeResult).toHaveBeenCalledTimes(2)
    expect(callRuntimeResult).toHaveBeenNthCalledWith(1, 'ui.set', {}, 15_000)
    expect(callRuntimeResult).toHaveBeenNthCalledWith(2, 'ui.set', {}, 15_000)
  })

  it('does not overwrite local navigation when shared UI is refreshed', async () => {
    const storage = new WindowStorage()
    installStorage(storage)
    const ui = createWebUiApi()
    await ui.set({
      activeView: 'tasks',
      lastActiveRepoId: 'repo-local',
      lastActiveWorktreeId: 'local'
    })
    callRuntimeResult.mockResolvedValueOnce({
      ui: {
        ...getDefaultUIState(),
        activeView: 'settings',
        lastActiveRepoId: 'repo-other',
        lastActiveWorktreeId: 'other'
      }
    })

    await expect(ui.get()).resolves.toMatchObject({
      activeView: 'tasks',
      lastActiveRepoId: 'repo-local',
      lastActiveWorktreeId: 'local'
    })
  })
})
