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
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  loadVisibleUsageProviders,
  loadVisibleUsageProvidersSettled,
  readDisabledTerminalLiveInputHandlesPreference,
  saveDisabledTerminalLiveInputHandles,
  saveHostSidebarWidth,
  saveTerminalAutocompleteEnabled,
  saveTerminalLinkOpenMode,
  saveVisibleUsageProviders,
  setUsageProviderVisible
} from './preferences'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

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

describe('visible usage providers preference', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('defaults to Claude + Codex when never set', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex']))
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:visibleUsageProviders')
  })

  it('round-trips a saved set in canonical order', async () => {
    await saveVisibleUsageProviders(new Set(['grok', 'claude', 'gemini']))

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:visibleUsageProviders',
      JSON.stringify(['claude', 'gemini', 'grok'])
    )
  })

  it('drops unknown or stale ids on load', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify(['claude', 'opencodeGo', 'bogus', 'grok'])
    )

    // 'opencodeGo' (field name, not the wire id) and 'bogus' are dropped.
    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'grok']))
  })

  it('preserves an explicit empty set as "show none"', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify([]))

    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set())
  })

  it('falls back to the default set for non-array corrupted JSON', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({}))

    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex']))
  })

  it('falls back to the default set when storage cannot be read', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex']))
  })
})

describe('setUsageProviderVisible (serialized read-modify-write)', () => {
  // Back the mock with an in-memory value so a toggle's read sees the prior
  // write — the whole point of the serialized read-modify-write.
  let store: string | null
  beforeEach(() => {
    store = null
    vi.mocked(AsyncStorage.getItem)
      .mockReset()
      .mockImplementation(async () => store)
    vi.mocked(AsyncStorage.setItem)
      .mockReset()
      .mockImplementation(async (_key, value) => {
        store = value as string
      })
  })

  // The bug: a toggle that persisted the whole set against a stale base dropped
  // a provider it never touched. Re-reading the latest set keeps it.
  it('adds a provider without dropping a stored-only one (the Grok race)', async () => {
    store = JSON.stringify(['claude', 'codex', 'grok'])

    const result = await setUsageProviderVisible('gemini', true)

    expect(result).toEqual(new Set(['claude', 'codex', 'gemini', 'grok']))
    await expect(loadVisibleUsageProviders()).resolves.toEqual(
      new Set(['claude', 'codex', 'gemini', 'grok'])
    )
  })

  it('removes only the toggled provider', async () => {
    store = JSON.stringify(['claude', 'codex', 'grok'])

    await setUsageProviderVisible('grok', false)

    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex']))
  })

  it('serializes concurrent toggles so neither is lost', async () => {
    store = JSON.stringify(['claude', 'codex'])

    await Promise.all([
      setUsageProviderVisible('grok', true),
      setUsageProviderVisible('gemini', true)
    ])

    await expect(loadVisibleUsageProviders()).resolves.toEqual(
      new Set(['claude', 'codex', 'gemini', 'grok'])
    )
  })

  it('aborts the write (keeps the stored set) when the read fails', async () => {
    store = JSON.stringify(['claude', 'codex', 'grok'])
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('read blip'))

    await expect(setUsageProviderVisible('gemini', true)).rejects.toThrow()
    // The stored set is untouched — a transient read failure must not persist
    // the default and drop Grok.
    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex', 'grok']))
  })

  it('self-heals malformed stored JSON by re-basing on the default', async () => {
    store = 'not json{'

    await setUsageProviderVisible('grok', true)

    // Malformed content is corrupt, not an I/O failure: re-base on the default
    // and rewrite so the toggle repairs the stored value instead of rejecting.
    await expect(loadVisibleUsageProviders()).resolves.toEqual(new Set(['claude', 'codex', 'grok']))
  })

  it('loadVisibleUsageProvidersSettled waits for an in-flight toggle', async () => {
    store = JSON.stringify(['claude', 'codex'])

    const pending = setUsageProviderVisible('grok', true)
    const settled = await loadVisibleUsageProvidersSettled()
    await pending

    expect(settled).toEqual(new Set(['claude', 'codex', 'grok']))
  })
})
