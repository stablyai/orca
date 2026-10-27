import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAppIconName, setAlternateAppIcon } from 'expo-alternate-app-icons'

vi.mock('react-native', () => ({
  Image: 'Image',
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronLeft: 'Icon' }))
vi.mock('expo-alternate-app-icons', () => ({
  supportsAlternateIcons: true,
  getAppIconName: vi.fn(),
  setAlternateAppIcon: vi.fn()
}))
vi.mock('./app-icon-previews', () => ({
  APP_ICON_PREVIEWS: { classic: 1, watercolor: 2, blue: 3 }
}))

const { default: AppIconSettingsScreen } = await import('./app-icon-settings-screen')

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function checkedLabel(): string | undefined {
  return renderer.root
    .findAll((node) => node.props.accessibilityRole === 'radio')
    .find((node) => node.props.accessibilityState?.checked)?.props.accessibilityLabel
}

async function press(label: string): Promise<void> {
  const row = renderer.root.find((node) => node.props.accessibilityLabel === label)
  await act(async () => row.props.onPress())
}

describe('app icon settings', () => {
  it('shows the active icon and switches to the one tapped, Classic being the default icon', async () => {
    vi.mocked(getAppIconName).mockReturnValue('Watercolor')
    vi.mocked(setAlternateAppIcon).mockResolvedValue('Blue')
    act(() => {
      renderer = create(createElement(AppIconSettingsScreen))
    })
    expect(checkedLabel()).toBe('Watercolor Orca')

    await press('Blue Orca')
    expect(setAlternateAppIcon).toHaveBeenLastCalledWith('Blue')
    await press('Classic Orca')
    expect(setAlternateAppIcon).toHaveBeenLastCalledWith(null)
    expect(checkedLabel()).toBe('Classic Orca')
  })

  it('goes back to the previous icon and says so when the change fails', async () => {
    vi.mocked(getAppIconName).mockReturnValue(null)
    vi.mocked(setAlternateAppIcon).mockRejectedValue(new Error('declined'))
    act(() => {
      renderer = create(createElement(AppIconSettingsScreen))
    })

    await press('Blue Orca')

    expect(checkedLabel()).toBe('Classic Orca')
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not change the app icon')
  })
})
