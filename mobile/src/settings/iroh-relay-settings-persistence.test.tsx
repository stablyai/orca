import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IROH_RELAY_PRESETS } from '../../../src/shared/iroh-relay-preference'
import { PickerModal } from '../components/PickerModal'
import { loadIrohHomeRelayUrl, saveIrohHomeRelayUrl } from '../storage/preferences'
import IrohRelaySettingsScreen from './iroh-relay-settings-screen'
import SettingsMenuScreen from './settings-menu-screen'

// Mock factories run before static imports; load the shared doubles inside the factories.
vi.mock(
  './settings-screen-frame',
  async () => (await import('../test-support/settings-chrome-test-double')).settingsFrameDouble
)
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
const mirrored = vi.hoisted(() => ({ listeners: new Set<(value: string | null) => void>() }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
vi.mock('lucide-react-native', () => ({
  Bell: 'Icon',
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Globe: 'Icon',
  Info: 'Icon',
  LifeBuoy: 'Icon',
  MessageSquare: 'Icon',
  Mic: 'Icon',
  Shield: 'Icon',
  SunMoon: 'Icon',
  Terminal: 'Icon',
  Wrench: 'Icon'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../storage/preferences', () => ({
  loadIrohHomeRelayUrl: vi.fn(),
  saveIrohHomeRelayUrl: vi.fn()
}))
vi.mock('../storage/mirrored-storage-keys', () => ({
  IROH_HOME_RELAY_URL_KEY: 'orca:irohHomeRelayUrl',
  subscribeMirroredKey: (_key: string, listener: (value: string | null) => void) => {
    mirrored.listeners.add(listener)
    return () => mirrored.listeners.delete(listener)
  }
}))

let renderer: ReactTestRenderer
const europe = IROH_RELAY_PRESETS.find(({ id }) => id === 'europe')!.relayUrl!
const asia = IROH_RELAY_PRESETS.find(({ id }) => id === 'asia')!.relayUrl!

beforeEach(() => {
  vi.mocked(loadIrohHomeRelayUrl).mockResolvedValue(null)
  vi.mocked(saveIrohHomeRelayUrl).mockResolvedValue()
})
afterEach(() => {
  act(() => renderer?.unmount())
  mirrored.listeners.clear()
  vi.resetAllMocks()
})

describe('phone Iroh relay settings', () => {
  it('opens the global relay route from Settings without any connected desktop', async () => {
    const push = vi.fn()
    await act(async () => {
      renderer = create(createElement(SettingsMenuScreen, { push, openExternal: vi.fn() }))
    })
    act(() => renderer.root.findByProps({ title: 'Iroh relay' }).props.onPress())
    expect(push).toHaveBeenCalledWith('/iroh-relay-settings')
  })

  it('keeps selection read-only until the durable preference is loaded', async () => {
    const loading = Promise.withResolvers<string | null>()
    vi.mocked(loadIrohHomeRelayUrl).mockReturnValue(loading.promise)
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    const row = renderer.root.findByProps({ accessibilityLabel: 'Phone Iroh home relay' })
    expect(row.props.disabled).toBe(true)
    expect(row.props.accessibilityState).toMatchObject({ disabled: true, busy: true })
    act(() => renderer.root.findByType(PickerModal).props.onSelect('asia'))
    expect(saveIrohHomeRelayUrl).not.toHaveBeenCalled()
    await act(async () => loading.resolve(europe))
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('europe')
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Phone Iroh home relay' }).props.disabled
    ).toBe(false)
  })

  it('reports a load failure and retries without overwriting the unknown saved value', async () => {
    vi.mocked(loadIrohHomeRelayUrl)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(europe)
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    expect(renderer.root.findByProps({ accessibilityRole: 'alert' })).toBeDefined()
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Phone Iroh home relay' }).props.disabled
    ).toBe(true)
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Retry loading relay preference' })
        .props.onPress()
    })
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('europe')
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0)
    expect(saveIrohHomeRelayUrl).not.toHaveBeenCalled()
  })

  it('keeps custom text as a draft, rejects invalid origins, and commits only on Save', async () => {
    const saving = Promise.withResolvers<void>()
    vi.mocked(saveIrohHomeRelayUrl).mockReturnValue(saving.promise)
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    act(() => renderer.root.findByType(PickerModal).props.onSelect('custom'))
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Custom Iroh relay URL' })
        .props.onChangeText('https://user:secret@relay.example/')
    })
    expect(saveIrohHomeRelayUrl).not.toHaveBeenCalled()
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Save relay' }).props.onPress())
    expect(saveIrohHomeRelayUrl).not.toHaveBeenCalled()
    const validationError = renderer.root.findByProps({ accessibilityRole: 'alert' })
    expect(validationError.props.children).not.toContain('secret')
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Custom Iroh relay URL' })
        .props.onChangeText(' HTTPS://RELAY.EXAMPLE:443 ')
    })
    expect(saveIrohHomeRelayUrl).not.toHaveBeenCalled()
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Save relay' }).props.onPress()
    })
    expect(saveIrohHomeRelayUrl).toHaveBeenCalledWith('https://relay.example/')
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Custom Iroh relay URL' }).props.editable
    ).toBe(false)
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Save relay' }).props.accessibilityState.busy
    ).toBe(true)
    await act(async () => saving.resolve())
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Custom Iroh relay URL' }).props.value
    ).toBe('https://relay.example/')
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Phone Iroh home relay' }).props.disabled
    ).toBe(false)
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Iroh relay status' }).props
        .accessibilityLiveRegion
    ).toBe('polite')
  })

  it('derives the named preset when a custom URL is saved as that preset origin', async () => {
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    act(() => renderer.root.findByType(PickerModal).props.onSelect('custom'))
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Custom Iroh relay URL' })
        .props.onChangeText(asia)
    })
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Save relay' }).props.onPress()
    })
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('asia')
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Custom Iroh relay URL' })
    ).toHaveLength(0)
  })

  it('rolls a failed custom save back to the committed selection and keeps controls usable', async () => {
    vi.mocked(loadIrohHomeRelayUrl).mockResolvedValue(europe)
    vi.mocked(saveIrohHomeRelayUrl).mockRejectedValue(new Error('storage full'))
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    act(() => renderer.root.findByType(PickerModal).props.onSelect('custom'))
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Custom Iroh relay URL' })
        .props.onChangeText('https://relay.example/')
    })
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Save relay' }).props.onPress()
    })
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('europe')
    expect(renderer.root.findByProps({ accessibilityRole: 'alert' })).toBeDefined()
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Phone Iroh home relay' }).props.disabled
    ).toBe(false)
    await act(async () => {
      vi.mocked(saveIrohHomeRelayUrl).mockResolvedValue()
      renderer.root.findByType(PickerModal).props.onSelect('automatic')
    })
    expect(saveIrohHomeRelayUrl).toHaveBeenLastCalledWith(null)
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('automatic')
  })

  it('does not replace a committed new selection with stale hydration', async () => {
    const hydration = Promise.withResolvers<string | null>()
    vi.mocked(loadIrohHomeRelayUrl).mockReturnValue(hydration.promise)
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    act(() => {
      for (const listener of mirrored.listeners) {
        listener(europe)
      }
    })
    await act(async () => {
      renderer.root.findByType(PickerModal).props.onSelect('asia')
    })
    await act(async () => hydration.resolve(null))
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('asia')
    expect(saveIrohHomeRelayUrl).toHaveBeenCalledWith(asia)
  })

  it('does not overwrite a newer durable notification when an older save completes', async () => {
    const saving = Promise.withResolvers<void>()
    vi.mocked(saveIrohHomeRelayUrl).mockReturnValue(saving.promise)
    await act(async () => {
      renderer = create(createElement(IrohRelaySettingsScreen))
    })
    await act(async () => {
      renderer.root.findByType(PickerModal).props.onSelect('europe')
    })
    act(() => {
      for (const listener of mirrored.listeners) {
        listener(europe)
      }
      for (const listener of mirrored.listeners) {
        listener(asia)
      }
    })
    await act(async () => saving.resolve())
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('asia')
  })
})
