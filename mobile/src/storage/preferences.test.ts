import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTerminalLinkOpenMode, saveTerminalLinkOpenMode } from './preferences'
import {
  loadDefaultSessionView,
  loadSessionViewOverrides,
  readDefaultSessionViewPreference,
  readSessionViewOverridesPreference,
  saveDefaultSessionView,
  updateSessionViewOverride
} from './session-view-preferences'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
  }
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('session view preference', () => {
  beforeEach(() => {
    stored.clear()
    vi.mocked(AsyncStorage.getItem)
      .mockReset()
      .mockImplementation(async (key) => stored.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem)
      .mockReset()
      .mockImplementation(async (key, value) => {
        stored.set(key, value)
      })
  })

  it('marks an unreadable default as not loaded so the opt-in gate can bail', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))
    await expect(readDefaultSessionViewPreference()).resolves.toEqual({
      value: null,
      loaded: false,
      hasStoredValue: false
    })
    await expect(loadDefaultSessionView()).resolves.toBe('terminal')
  })

  it('migrates the legacy array format to chat overrides', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(['tab-1', 42, 'tab-2']))

    const loaded = await loadSessionViewOverrides('host', 'wt')
    expect([...loaded.entries()]).toEqual([
      ['tab-1', 'chat'],
      ['tab-2', 'chat']
    ])
  })

  it('serializes default writes across callers and makes reads wait for the latest', async () => {
    let stored = 'terminal'
    const firstWrite = deferred<void>()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (_key, value) => {
        await firstWrite.promise
        stored = value
      })
      .mockImplementation(async (_key, value) => {
        stored = value
      })

    const older = saveDefaultSessionView('chat')
    await Promise.resolve()
    const newer = saveDefaultSessionView('terminal')
    const reloaded = loadDefaultSessionView()
    await Promise.resolve()

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await Promise.all([older, newer])

    await expect(reloaded).resolves.toBe('terminal')
    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(1, 'orca:defaultSessionView', 'chat')
    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(2, 'orca:defaultSessionView', 'terminal')
  })

  it('continues the shared default queue after a failed write', async () => {
    let stored = 'terminal'
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(async (_key, value) => {
        stored = value
      })

    const failed = expect(saveDefaultSessionView('terminal')).rejects.toThrow('storage unavailable')
    const latest = saveDefaultSessionView('chat')
    await failed
    await latest

    await expect(loadDefaultSessionView()).resolves.toBe('chat')
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2)
  })

  it('orders per-tab mutations across callers without losing saved siblings', async () => {
    let stored = JSON.stringify({ saved: 'chat' })
    const firstWrite = deferred<void>()
    const firstStarted = deferred<void>()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (_key, value) => {
        firstStarted.resolve()
        await firstWrite.promise
        stored = value
      })
      .mockImplementation(async (_key, value) => {
        stored = value
      })

    const first = updateSessionViewOverride('host', 'worktree', 'first', 'terminal')
    await firstStarted.promise
    const second = updateSessionViewOverride('host', 'worktree', 'second', 'chat')
    const reloaded = loadSessionViewOverrides('host', 'worktree')

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await Promise.all([first, second])

    await expect(reloaded).resolves.toEqual(
      new Map([
        ['saved', 'chat'],
        ['first', 'terminal'],
        ['second', 'chat']
      ])
    )
  })

  it('does not globally block updates for a different host and worktree', async () => {
    const blockedWrite = deferred<void>()
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key) => {
      if (key.includes('blocked-host')) {
        await blockedWrite.promise
      }
    })

    const blocked = updateSessionViewOverride('blocked-host', 'worktree', 'tab', 'chat')
    await Promise.resolve()
    await Promise.resolve()
    await updateSessionViewOverride('other-host', 'worktree', 'tab', 'terminal')

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:nativeChatTabs:other-host:worktree',
      JSON.stringify({ tab: 'terminal' })
    )
    blockedWrite.resolve()
    await blocked
  })

  it('continues a scoped override queue after a failed write', async () => {
    let stored: string | null = null
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(async (_key, value) => {
        stored = value
      })

    const failed = updateSessionViewOverride('host', 'worktree', 'first', 'chat')
    const latest = updateSessionViewOverride('host', 'worktree', 'second', 'terminal')
    await expect(failed).rejects.toThrow('storage unavailable')
    await latest

    await expect(loadSessionViewOverrides('host', 'worktree')).resolves.toEqual(
      new Map([['second', 'terminal']])
    )
  })

  it('does not replace saved overrides after a transient read failure', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(readSessionViewOverridesPreference('host', 'worktree')).resolves.toEqual({
      overrides: new Map(),
      loaded: false
    })

    await expect(updateSessionViewOverride('host', 'worktree', 'tab', 'chat')).rejects.toThrow(
      'Session view overrides could not be read'
    )

    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('repairs invalid preference data on the next user mutation', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('not-json')

    await updateSessionViewOverride('host', 'worktree', 'tab', 'chat')

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:nativeChatTabs:host:worktree',
      JSON.stringify({ tab: 'chat' })
    )
  })
})

describe('terminal link open mode preference', () => {
  beforeEach(() => {
    stored.clear()
    vi.mocked(AsyncStorage.getItem)
      .mockReset()
      .mockImplementation(async (key) => stored.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem)
      .mockReset()
      .mockImplementation(async (key, value) => {
        stored.set(key, value)
      })
  })

  it('orders writes across settings mounts and makes readers wait for the latest choice', async () => {
    const firstWrite = deferred<void>()
    let stored: string | null = 'orca-browser'
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (_key, value) => {
      if (value === 'phone-browser') {
        await firstWrite.promise
      }
      stored = value
    })
    const firstMount = saveTerminalLinkOpenMode('phone-browser')
    const secondMount = saveTerminalLinkOpenMode('orca-browser')
    const reader = loadTerminalLinkOpenMode()
    await Promise.resolve()
    expect(stored).toBe('orca-browser')
    firstWrite.resolve()
    await Promise.all([firstMount, secondMount])
    await expect(reader).resolves.toBe('orca-browser')
    expect(stored).toBe('orca-browser')
  })
})
