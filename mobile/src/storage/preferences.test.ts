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
  loadPushNotificationsEnabled,
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  readPushNotificationsPreference,
  readDisabledTerminalLiveInputHandlesPreference,
  saveDisabledTerminalLiveInputHandles,
  saveHostSidebarWidth,
  savePushNotificationsEnabled,
  saveTerminalAutocompleteEnabled,
  saveTerminalLinkOpenMode
} from './preferences'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

describe('push notification preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('distinguishes an unset preference from an explicit disabled choice', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
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

  it('persists the onboarding decision in the existing mobile toggle', async () => {
    await savePushNotificationsEnabled(true)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:pushNotificationsEnabled', 'true')

    await savePushNotificationsEnabled(false)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:pushNotificationsEnabled', 'false')
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
