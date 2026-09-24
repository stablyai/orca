import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_DOCK_MAX_WIDTH,
  HOST_DOCK_MIN_WIDTH,
  HOST_SIDEBAR_DEFAULT_WIDTH,
  HOST_SIDEBAR_MAX_WIDTH,
  HOST_SIDEBAR_MIN_WIDTH,
  clampHostDockWidth,
  clampHostSidebarWidth,
  loadDisabledTerminalLiveInputHandles,
  loadHostSidebarWidth,
  loadMobileWebShellEnabled,
  loadPushNotificationsEnabled,
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  mobileShellBuildKind,
  mobileWebShellFlagCanBeOn,
  readPushNotificationsPreference,
  readDisabledTerminalLiveInputHandlesPreference,
  saveDisabledTerminalLiveInputHandles,
  saveHostSidebarWidth,
  savePushNotificationsEnabled,
  saveTerminalAutocompleteEnabled,
  saveTerminalLinkOpenMode
} from './preferences'
import {
  loadDefaultSessionView,
  loadSessionViewOverrides,
  readDefaultSessionViewPreference,
  readSessionViewOverridesPreference,
  saveDefaultSessionView,
  updateSessionViewOverride
} from './session-view-preferences'

// A store rather than two bare spies: the mirrored write path reads a key back after writing it,
// so a `setItem` that answers with nothing is not a store any caller could have (ruling 35).
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(async () => undefined)
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
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('defaults to terminal and persists the chat default', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
    await expect(loadDefaultSessionView()).resolves.toBe('terminal')
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:defaultSessionView')

    await saveDefaultSessionView('chat')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:defaultSessionView', 'chat')

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('bogus')
    await expect(loadDefaultSessionView()).resolves.toBe('terminal')
  })

  it('reports an absent default as an undecided (null) preference', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
    await expect(readDefaultSessionViewPreference()).resolves.toEqual({
      value: null,
      loaded: true,
      hasStoredValue: false
    })

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('chat')
    await expect(readDefaultSessionViewPreference()).resolves.toEqual({
      value: 'chat',
      loaded: true,
      hasStoredValue: true
    })

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('bogus')
    await expect(readDefaultSessionViewPreference()).resolves.toEqual({
      value: null,
      loaded: true,
      hasStoredValue: true
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

  it('loads and updates per-tab overrides under a host-and-worktree scoped key', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify({ 'tab-1': 'chat', 'tab-2': 'terminal', 'tab-3': 'bogus' })
    )

    const loaded = await loadSessionViewOverrides('host/one', 'folder:C:\\repo')
    expect([...loaded.entries()]).toEqual([
      ['tab-1', 'chat'],
      ['tab-2', 'terminal']
    ])
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(
      'orca:nativeChatTabs:host%2Fone:folder%3AC%3A%5Crepo'
    )

    await updateSessionViewOverride('host/one', 'folder:C:\\repo', 'tab-2', 'chat')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:nativeChatTabs:host%2Fone:folder%3AC%3A%5Crepo',
      JSON.stringify({ 'tab-1': 'chat', 'tab-2': 'chat' })
    )
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
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => stored)
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (_key, value) => {
        await firstWrite.promise
        stored = value
      })
      .mockImplementation(async (_key, value) => {
        stored = value
      })

    const first = updateSessionViewOverride('host', 'worktree', 'first', 'terminal')
    await vi.waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1))
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

describe('push notification preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it.each(['true', 'false'])('requires fresh consent for legacy choice %s', async (legacy) => {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) =>
      key === 'orca:pushNotificationsEnabled' ? legacy : null
    )
    await expect(readPushNotificationsPreference()).resolves.toEqual({ value: null, loaded: true })
    await expect(loadPushNotificationsEnabled()).resolves.toBe(false)
  })

  it('distinguishes an unset preference from an explicit disabled choice', async () => {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) =>
      key === 'orca:remotePushEnabled' ? 'true' : null
    )
    await expect(readPushNotificationsPreference()).resolves.toEqual({
      value: null,
      loaded: true
    })
    await expect(loadPushNotificationsEnabled()).resolves.toBe(false)

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('false')
    await expect(readPushNotificationsPreference()).resolves.toEqual({
      value: false,
      loaded: true
    })
  })

  it('reports storage failures without enabling notifications', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(readPushNotificationsPreference()).resolves.toEqual({
      value: null,
      loaded: false
    })
    await expect(loadPushNotificationsEnabled()).resolves.toBe(false)
  })

  it('persists and reloads master consent', async () => {
    const storage = new Map<string, string>()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      storage.set(key, value)
    })
    for (const enabled of [true, false]) {
      await savePushNotificationsEnabled(enabled)
      await expect(loadPushNotificationsEnabled()).resolves.toBe(enabled)
    }
    expect([...storage]).toEqual([['orca:pushServiceNotificationsEnabled', 'false']])
  })
})

describe('terminal autocomplete preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('defaults to disabled when unset', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadTerminalAutocompleteEnabled()).resolves.toBe(false)
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:terminalAutocompleteEnabled')
  })

  it('loads enabled only from the persisted true value', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('true')

    await expect(loadTerminalAutocompleteEnabled()).resolves.toBe(true)

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('false')

    await expect(loadTerminalAutocompleteEnabled()).resolves.toBe(false)
  })

  it('falls back to disabled when storage cannot be read', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(loadTerminalAutocompleteEnabled()).resolves.toBe(false)
  })

  it('persists the selected value', async () => {
    await saveTerminalAutocompleteEnabled(true)

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalAutocompleteEnabled', 'true')

    await saveTerminalAutocompleteEnabled(false)

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalAutocompleteEnabled', 'false')
  })
})

describe('terminal live input disabled handles preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('defaults to no disabled handles when unset', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadDisabledTerminalLiveInputHandles('host-1', 'worktree-1')).resolves.toEqual(
      new Set()
    )
    await expect(
      readDisabledTerminalLiveInputHandlesPreference('host-1', 'worktree-1')
    ).resolves.toEqual({ handles: new Set(), loaded: true })
  })

  it('loads only string terminal handles from storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(['pty-1', 42, 'pty-2']))

    await expect(loadDisabledTerminalLiveInputHandles('host-1', 'worktree-1')).resolves.toEqual(
      new Set(['pty-1', 'pty-2'])
    )
  })

  it('falls back to no disabled handles for invalid or unreadable storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('not-json')

    await expect(loadDisabledTerminalLiveInputHandles('host-1', 'worktree-1')).resolves.toEqual(
      new Set()
    )

    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(loadDisabledTerminalLiveInputHandles('host-1', 'worktree-1')).resolves.toEqual(
      new Set()
    )
    await expect(
      readDisabledTerminalLiveInputHandlesPreference('host-1', 'worktree-1')
    ).resolves.toEqual({ handles: new Set(), loaded: false })
  })

  it('persists disabled handles per host and worktree', async () => {
    await saveDisabledTerminalLiveInputHandles(
      'host/one',
      'folder:C:\\repo',
      new Set(['pty-2', 'pty-1'])
    )

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:terminalLiveInputDisabled:host%2Fone:folder%3AC%3A%5Crepo',
      JSON.stringify(['pty-2', 'pty-1'])
    )
  })
})

describe('host sidebar width preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('clamps saved widths to the supported sidebar range', () => {
    expect(clampHostSidebarWidth(HOST_SIDEBAR_MIN_WIDTH - 10)).toBe(HOST_SIDEBAR_MIN_WIDTH)
    expect(clampHostSidebarWidth(HOST_SIDEBAR_MAX_WIDTH + 10)).toBe(HOST_SIDEBAR_MAX_WIDTH)
    expect(clampHostSidebarWidth(337.6)).toBe(338)
  })

  it('falls back to the default width for missing, invalid, or unreadable storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadHostSidebarWidth()).resolves.toBe(HOST_SIDEBAR_DEFAULT_WIDTH)

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('not-a-number')

    await expect(loadHostSidebarWidth()).resolves.toBe(HOST_SIDEBAR_DEFAULT_WIDTH)

    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(loadHostSidebarWidth()).resolves.toBe(HOST_SIDEBAR_DEFAULT_WIDTH)
  })

  it('loads and persists clamped sidebar widths', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(String(HOST_SIDEBAR_MAX_WIDTH + 20))

    await expect(loadHostSidebarWidth()).resolves.toBe(HOST_SIDEBAR_MAX_WIDTH)

    await saveHostSidebarWidth(HOST_SIDEBAR_MIN_WIDTH - 20)

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:hostSidebarWidth',
      String(HOST_SIDEBAR_MIN_WIDTH)
    )
  })
})

describe('host dock width preference', () => {
  it('clamps saved widths to the supported dock range', () => {
    expect(clampHostDockWidth(HOST_DOCK_MIN_WIDTH - 10)).toBe(HOST_DOCK_MIN_WIDTH)
    expect(clampHostDockWidth(HOST_DOCK_MAX_WIDTH + 10)).toBe(HOST_DOCK_MAX_WIDTH)
    expect(clampHostDockWidth(337.6)).toBe(338)
  })
})

describe('terminal link open mode preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('defaults to Orca browser when unset', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadTerminalLinkOpenMode()).resolves.toBe('orca-browser')
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:terminalLinkOpenMode')
  })

  it('loads only known modes', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('phone-browser')
    await expect(loadTerminalLinkOpenMode()).resolves.toBe('phone-browser')

    vi.mocked(AsyncStorage.getItem).mockResolvedValue('external')
    await expect(loadTerminalLinkOpenMode()).resolves.toBe('orca-browser')
  })

  it('falls back to Orca browser when storage cannot be read', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(loadTerminalLinkOpenMode()).resolves.toBe('orca-browser')
  })

  it('persists the selected mode', async () => {
    await saveTerminalLinkOpenMode('phone-browser')

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalLinkOpenMode', 'phone-browser')
  })
})

/** `__DEV__` is a React Native global, absent outside that runtime; assigned rather than cast so
 *  the test says which build kind it is running as without asserting a type on `globalThis`. */
function setDevelopmentBuild(isDevelopmentBuild: boolean | undefined): void {
  if (isDevelopmentBuild === undefined) {
    Reflect.deleteProperty(globalThis, '__DEV__')
    return
  }
  Object.assign(globalThis, { __DEV__: isDevelopmentBuild })
}

/** The build-time constant the release workflow sets. Under Metro this name is inlined before the
 *  bundle is written, so these cases measure the answer the inlined value produces, not the read. */
function setShellBuildSwitch(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, 'EXPO_PUBLIC_MOBILE_SHELL')
    return
  }
  process.env.EXPO_PUBLIC_MOBILE_SHELL = value
}

describe('the mobile shell build kind', () => {
  beforeEach(() => {
    setShellBuildSwitch(undefined)
  })

  it('is native when the build set no switch at all, which is every default build', () => {
    expect(mobileShellBuildKind()).toBe('native')
  })

  it.each([[''], ['native'], ['OTA'], [' ota'], ['ota-preview'], ['true']])(
    'is native for %p, so only the exact word opts in',
    (value) => {
      setShellBuildSwitch(value)

      expect(mobileShellBuildKind()).toBe('native')
    }
  )

  it('is ota when the build set exactly that', () => {
    setShellBuildSwitch('ota')

    expect(mobileShellBuildKind()).toBe('ota')
  })
})

describe('whether the hybrid shell flag can be on', () => {
  beforeEach(() => {
    setDevelopmentBuild(undefined)
    setShellBuildSwitch(undefined)
  })

  it.each([
    ['a release build', false],
    ['a runtime with no __DEV__ at all', undefined]
  ])('cannot be on in %s with no switch set', (_label, isDev) => {
    setDevelopmentBuild(isDev)

    expect(mobileWebShellFlagCanBeOn()).toBe(false)
  })

  it.each([
    ['a release build', false],
    ['a runtime with no __DEV__ at all', undefined]
  ])('can be on in %s built with the switch set to ota', (_label, isDev) => {
    setDevelopmentBuild(isDev)
    setShellBuildSwitch('ota')

    expect(mobileWebShellFlagCanBeOn()).toBe(true)
  })

  it('can be on in a development build whatever the switch says', () => {
    setDevelopmentBuild(true)

    expect(mobileWebShellFlagCanBeOn()).toBe(true)
  })
})

describe('hybrid shell flag', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    setDevelopmentBuild(undefined)
    setShellBuildSwitch(undefined)
  })

  it('reads the developer toggle in a development build', async () => {
    setDevelopmentBuild(true)
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('true')

    await expect(loadMobileWebShellEnabled()).resolves.toBe(true)
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:mobileWebShellEnabled')
  })

  it('is off in a development build until the toggle writes it on', async () => {
    setDevelopmentBuild(true)
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadMobileWebShellEnabled()).resolves.toBe(false)
  })

  it.each([
    ['a release build', false],
    ['a runtime with no __DEV__ at all', undefined]
  ])('is off in %s even with the key left on, and never reads it', async (_label, isDev) => {
    setDevelopmentBuild(isDev)
    // The value a development build, or an OTA build this one was installed over, left behind in
    // a container the install-over kept. The ability comes from the build, so the key cannot
    // revive it — this is the case a native build shipped over an OTA build has to survive.
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('true')

    await expect(loadMobileWebShellEnabled()).resolves.toBe(false)
    expect(AsyncStorage.getItem).not.toHaveBeenCalled()
  })

  it.each([
    ['a release build', false],
    ['a runtime with no __DEV__ at all', undefined]
  ])('is on in %s built for ota with the key never written', async (_label, isDev) => {
    setDevelopmentBuild(isDev)
    setShellBuildSwitch('ota')
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadMobileWebShellEnabled()).resolves.toBe(true)
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:mobileWebShellEnabled')
  })

  it('obeys an explicit off written by the Troubleshoot toggle in an ota build', async () => {
    setDevelopmentBuild(false)
    setShellBuildSwitch('ota')
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('false')

    await expect(loadMobileWebShellEnabled()).resolves.toBe(false)
  })

  it('is off in an ota build whose store cannot be read at all', async () => {
    setDevelopmentBuild(false)
    setShellBuildSwitch('ota')
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('no store'))

    await expect(loadMobileWebShellEnabled()).resolves.toBe(false)
  })
})
