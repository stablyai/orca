import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionSettingsScreen from './connection-settings-screen'
import { MobileSwitch } from '../components/MobileSwitch'
import { SettingsNote } from './settings-screen-frame'
import {
  isRelayBackgroundExtended,
  loadRelayBackgroundExtended,
  saveRelayBackgroundExtended
} from '../storage/relay-background-preference'

vi.mock(
  './settings-screen-frame',
  async () => (await import('../test-support/settings-chrome-test-double')).settingsFrameDouble
)
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../storage/relay-background-preference', () => ({
  isRelayBackgroundExtended: vi.fn(),
  loadRelayBackgroundExtended: vi.fn(),
  saveRelayBackgroundExtended: vi.fn()
}))

let renderer: ReactTestRenderer
beforeEach(() => vi.resetAllMocks())
afterEach(() => act(() => renderer?.unmount()))

describe('Connections settings', () => {
  it('loads the saved opt-in and saves a change before updating the switch', async () => {
    vi.mocked(loadRelayBackgroundExtended).mockResolvedValue(true)
    let finishSave: () => void = () => {}
    vi.mocked(saveRelayBackgroundExtended).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve
        })
    )
    await act(async () => {
      renderer = create(createElement(ConnectionSettingsScreen))
    })
    expect(renderer.root.findByType(MobileSwitch).props.value).toBe(true)
    await act(async () => renderer.root.findByType(MobileSwitch).props.onValueChange(false))
    expect(renderer.root.findByType(MobileSwitch).props.disabled).toBe(true)
    expect(saveRelayBackgroundExtended).toHaveBeenCalledExactlyOnceWith(false)
    await act(async () => finishSave())
    expect(renderer.root.findByType(MobileSwitch).props.value).toBe(false)
    expect(renderer.root.findByType(MobileSwitch).props.disabled).toBe(false)
  })

  it('shows a rejected save without claiming the option changed', async () => {
    vi.mocked(loadRelayBackgroundExtended).mockResolvedValue(false)
    vi.mocked(saveRelayBackgroundExtended).mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      renderer = create(createElement(ConnectionSettingsScreen))
    })
    await act(async () => renderer.root.findByType(MobileSwitch).props.onValueChange(true))
    expect(renderer.root.findByType(MobileSwitch).props.value).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not save connection preferences')
    expect(renderer.root.findByType(SettingsNote).props.error).toBe(true)
  })

  it('keeps the live opt-in when a later load fails', async () => {
    vi.mocked(loadRelayBackgroundExtended).mockRejectedValue(new Error('storage unavailable'))
    vi.mocked(isRelayBackgroundExtended).mockReturnValue(true)
    await act(async () => {
      renderer = create(createElement(ConnectionSettingsScreen))
    })
    expect(renderer.root.findByType(MobileSwitch).props.value).toBe(true)
    expect(renderer.root.findByType(SettingsNote).props.error).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not load connection preferences')
  })

  it('does not show an opt-in when a failed load has no saved choice', async () => {
    vi.mocked(loadRelayBackgroundExtended).mockRejectedValue(new Error('storage unavailable'))
    vi.mocked(isRelayBackgroundExtended).mockReturnValue(false)
    await act(async () => {
      renderer = create(createElement(ConnectionSettingsScreen))
    })
    expect(renderer.root.findByType(MobileSwitch).props.value).toBe(false)
    expect(renderer.root.findByType(SettingsNote).props.error).toBe(true)
  })

  it('disables changes while loading the saved choice', async () => {
    vi.mocked(loadRelayBackgroundExtended).mockImplementation(() => new Promise(() => {}))
    await act(async () => {
      renderer = create(createElement(ConnectionSettingsScreen))
    })
    expect(renderer.root.findByType(MobileSwitch).props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Your phone may suspend the connection sooner'
    )
  })
})
