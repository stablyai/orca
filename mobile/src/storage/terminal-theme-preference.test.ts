import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

// Why: the preference store is a module singleton, so every case needs a fresh graph.
async function freshStore() {
  vi.resetModules()
  const storage = (await import('@react-native-async-storage/async-storage')).default
  vi.mocked(storage.getItem).mockResolvedValue(null)
  vi.mocked(storage.setItem).mockResolvedValue(undefined)
  vi.mocked(storage.removeItem).mockResolvedValue(undefined)
  const module = await import('./terminal-theme-preference')
  return { storage, ...module }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('mobile terminal theme preference', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults to following the desktop palette when nothing is stored', async () => {
    const store = await freshStore()

    await expect(store.loadMobileTerminalThemeSelection()).resolves.toEqual({
      dark: null,
      light: null,
      useSeparateLightTheme: true
    })
    expect(store.storage.getItem).toHaveBeenCalledWith('orca:terminalThemeDark')
    expect(store.storage.getItem).toHaveBeenCalledWith('orca:terminalThemeLight')
    expect(store.storage.getItem).toHaveBeenCalledWith('orca:terminalUseSeparateLightTheme')
  })

  it('loads stored slots and the inverted separate-light flag', async () => {
    const store = await freshStore()
    vi.mocked(store.storage.getItem).mockImplementation(async (key: string) =>
      key === 'orca:terminalThemeDark'
        ? 'One Dark'
        : key === 'orca:terminalThemeLight'
          ? 'GitHub Light'
          : 'false'
    )

    await expect(store.loadMobileTerminalThemeSelection()).resolves.toEqual({
      dark: 'One Dark',
      light: 'GitHub Light',
      useSeparateLightTheme: false
    })
  })

  it('degrades an uncatalogued stored name to following the desktop palette', async () => {
    const store = await freshStore()
    vi.mocked(store.storage.getItem).mockImplementation(async (key: string) =>
      key === 'orca:terminalThemeDark' ? 'Theme That Was Renamed' : null
    )

    await expect(store.loadMobileTerminalThemeSelection()).resolves.toEqual({
      dark: null,
      light: null,
      useSeparateLightTheme: true
    })
  })

  it('memoises the load so extra subscribers cost no storage reads', async () => {
    const store = await freshStore()

    await store.loadMobileTerminalThemeSelection()
    await store.loadMobileTerminalThemeSelection()

    expect(store.storage.getItem).toHaveBeenCalledTimes(3)
  })

  it('writes all three keys and removes the key for a follow-desktop slot', async () => {
    const store = await freshStore()

    await store.saveMobileTerminalThemeSelection({ dark: 'Nord' })

    expect(store.storage.setItem).toHaveBeenCalledWith('orca:terminalThemeDark', 'Nord')
    expect(store.storage.setItem).toHaveBeenCalledWith('orca:terminalUseSeparateLightTheme', 'true')
    expect(store.storage.removeItem).toHaveBeenCalledWith('orca:terminalThemeLight')
    expect(store.storage.setItem).toHaveBeenCalledTimes(2)
    expect(store.storage.removeItem).toHaveBeenCalledTimes(1)
  })

  it('keeps the untouched stored slots when a save precedes the first load', async () => {
    const store = await freshStore()
    const stored: Record<string, string | null> = {
      'orca:terminalThemeDark': 'Nord',
      'orca:terminalThemeLight': 'GitHub Light',
      'orca:terminalUseSeparateLightTheme': 'false'
    }
    vi.mocked(store.storage.getItem).mockImplementation(async (key: string) => stored[key] ?? null)
    vi.mocked(store.storage.setItem).mockImplementation(async (key: string, value: string) => {
      stored[key] = value
    })
    vi.mocked(store.storage.removeItem).mockImplementation(async (key: string) => {
      stored[key] = null
    })

    await store.saveMobileTerminalThemeSelection({ dark: 'One Dark' })

    expect(stored).toEqual({
      'orca:terminalThemeDark': 'One Dark',
      'orca:terminalThemeLight': 'GitHub Light',
      'orca:terminalUseSeparateLightTheme': 'false'
    })
    expect(store.getMobileTerminalThemeSelection()).toEqual({
      dark: 'One Dark',
      light: 'GitHub Light',
      useSeparateLightTheme: false
    })
  })

  it('retries a failed read instead of pinning the default for the session', async () => {
    const store = await freshStore()
    vi.mocked(store.storage.getItem).mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(store.loadMobileTerminalThemeSelection()).resolves.toEqual({
      dark: null,
      light: null,
      useSeparateLightTheme: true
    })

    vi.mocked(store.storage.getItem).mockImplementation(async (key: string) =>
      key === 'orca:terminalThemeDark' ? 'One Dark' : null
    )

    await expect(store.loadMobileTerminalThemeSelection()).resolves.toEqual({
      dark: 'One Dark',
      light: null,
      useSeparateLightTheme: true
    })
  })

  it('writes only the patched slot when the read failed, so the others survive', async () => {
    const store = await freshStore()
    // Read fails but writes succeed: the merge base is the in-memory default, so
    // writing the untouched slots would erase what is really on disk.
    vi.mocked(store.storage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await store.saveMobileTerminalThemeSelection({ dark: 'One Dark' })

    expect(store.storage.setItem).toHaveBeenCalledExactlyOnceWith(
      'orca:terminalThemeDark',
      'One Dark'
    )
    expect(store.storage.removeItem).not.toHaveBeenCalled()
  })

  it('publishes to subscribers before the write resolves', async () => {
    const store = await freshStore()
    const pending = deferred<undefined>()
    vi.mocked(store.storage.setItem).mockReturnValue(pending.promise)
    const notified = vi.fn()
    store.subscribeMobileTerminalThemeSelection(notified)

    const write = store.saveMobileTerminalThemeSelection({ dark: 'Dracula' })

    expect(notified).toHaveBeenCalledTimes(1)
    expect(store.getMobileTerminalThemeSelection().dark).toBe('Dracula')
    pending.resolve(undefined)
    await write
  })

  it('keeps snapshot identity until a value actually changes', async () => {
    const store = await freshStore()
    const notified = vi.fn()
    store.subscribeMobileTerminalThemeSelection(notified)

    const initial = store.getMobileTerminalThemeSelection()
    await store.loadMobileTerminalThemeSelection()
    expect(store.getMobileTerminalThemeSelection()).toBe(initial)

    await store.saveMobileTerminalThemeSelection({ useSeparateLightTheme: true })
    expect(store.getMobileTerminalThemeSelection()).toBe(initial)
    expect(notified).not.toHaveBeenCalled()

    await store.saveMobileTerminalThemeSelection({ dark: 'Nord' })
    expect(store.getMobileTerminalThemeSelection()).not.toBe(initial)
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('lets a choice made during an in-flight load win over storage', async () => {
    const store = await freshStore()
    const pending = deferred<string | null>()
    const publishedDark: (string | null)[] = []
    store.subscribeMobileTerminalThemeSelection(() => {
      publishedDark.push(store.getMobileTerminalThemeSelection().dark)
    })
    vi.mocked(store.storage.getItem).mockImplementation(async (key: string) =>
      key === 'orca:terminalThemeDark' ? pending.promise : null
    )

    const load = store.loadMobileTerminalThemeSelection()
    const write = store.saveMobileTerminalThemeSelection({ dark: 'Nord' })
    expect(store.getMobileTerminalThemeSelection().dark).toBe('Nord')
    expect(publishedDark).toEqual(['Nord'])
    pending.resolve('Dracula')
    await Promise.all([load, write])

    expect(store.getMobileTerminalThemeSelection().dark).toBe('Nord')
    expect(publishedDark).toEqual(['Nord'])
    expect(store.storage.setItem).toHaveBeenCalledWith('orca:terminalThemeDark', 'Nord')
  })

  it('unsubscribing stops further notifications', async () => {
    const store = await freshStore()
    const notified = vi.fn()
    const unsubscribe = store.subscribeMobileTerminalThemeSelection(notified)

    unsubscribe()
    await store.saveMobileTerminalThemeSelection({ dark: 'Nord' })

    expect(notified).not.toHaveBeenCalled()
  })
})
