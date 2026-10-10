import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronLeft: 'Icon' }))
vi.mock('../app-icon/app-icon-preview-assets', () => ({
  APP_ICON_PREVIEW_ASSETS: { classic: 1, watercolor: 2, blue: 3 }
}))
const switcher = vi.hoisted(() => ({ loadAppIcon: vi.fn(), saveAppIcon: vi.fn() }))
vi.mock('../app-icon/app-icon-switcher', () => switcher)

const { default: AppIconSettingsScreen } = await import('./app-icon-settings-screen')

let renderer: ReactTestRenderer

beforeEach(() => {
  switcher.loadAppIcon.mockReset()
  switcher.saveAppIcon.mockReset()
})

afterEach(() => {
  act(() => renderer?.unmount())
})

async function render(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(AppIconSettingsScreen))
  })
}

function option(label: string) {
  return renderer.root.find(
    (node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === label
  )
}

function checkedLabel(): string | undefined {
  return renderer.root
    .findAll((node) => node.props.accessibilityRole === 'radio')
    .find((node) => node.props.accessibilityState.checked)?.props.accessibilityLabel
}

function alertText(): string | undefined {
  const alert = renderer.root.findAll((node) => node.props.accessibilityRole === 'alert')[0]
  return alert?.props.children
}

describe('app icon settings', () => {
  it('marks the icon the OS reports as current', async () => {
    switcher.loadAppIcon.mockResolvedValue({ supported: true, iconId: 'watercolor' })
    await render()
    expect(checkedLabel()).toBe('Watercolor Orca')
  })

  it('switches the icon when a different option is tapped', async () => {
    switcher.loadAppIcon.mockResolvedValue({ supported: true, iconId: 'classic' })
    switcher.saveAppIcon.mockResolvedValue(undefined)
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    expect(switcher.saveAppIcon).toHaveBeenCalledWith('blue')
    expect(checkedLabel()).toBe('Blue Orca')
  })

  it('restores the previous icon and explains when the OS refuses the change', async () => {
    switcher.loadAppIcon.mockResolvedValue({ supported: true, iconId: 'classic' })
    switcher.saveAppIcon.mockRejectedValue(new Error('denied'))
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    expect(checkedLabel()).toBe('Classic Orca')
    expect(alertText()).toBe('Could not change the app icon. Try again.')
  })

  it('keeps a tap made before the initial read resolves', async () => {
    let resolveLoad: (value: unknown) => void = () => {}
    switcher.loadAppIcon.mockReturnValue(new Promise((resolve) => (resolveLoad = resolve)))
    switcher.saveAppIcon.mockResolvedValue(undefined)
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    await act(async () => resolveLoad({ supported: true, iconId: 'classic' }))
    expect(checkedLabel()).toBe('Blue Orca')
  })

  it('falls back to the icon shown before the tap when the OS cannot be re-read', async () => {
    switcher.loadAppIcon
      .mockResolvedValueOnce({ supported: true, iconId: 'watercolor' })
      .mockRejectedValue(new Error('unavailable'))
    switcher.saveAppIcon.mockRejectedValue(new Error('denied'))
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    expect(checkedLabel()).toBe('Watercolor Orca')
    expect(alertText()).toBe('Could not change the app icon. Try again.')
  })

  it('ignores a failure from a change the user has already superseded', async () => {
    let rejectBlue: (error: Error) => void = () => {}
    switcher.loadAppIcon.mockResolvedValue({ supported: true, iconId: 'classic' })
    switcher.saveAppIcon.mockImplementation((iconId: string) =>
      iconId === 'blue'
        ? new Promise((_resolve, reject) => (rejectBlue = reject))
        : Promise.resolve()
    )
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    await act(async () => option('Watercolor Orca').props.onPress())
    await act(async () => rejectBlue(new Error('denied')))
    expect(switcher.saveAppIcon.mock.calls).toEqual([['blue'], ['watercolor']])
    expect(checkedLabel()).toBe('Watercolor Orca')
    expect(alertText()).toBeUndefined()
  })

  it('runs one change at a time and skips queued changes that were superseded', async () => {
    let resolveBlue: () => void = () => {}
    switcher.loadAppIcon.mockResolvedValue({ supported: true, iconId: 'classic' })
    switcher.saveAppIcon.mockImplementation((iconId: string) =>
      iconId === 'blue'
        ? new Promise<void>((resolve) => (resolveBlue = resolve))
        : Promise.resolve()
    )
    await render()
    await act(async () => option('Blue Orca').props.onPress())
    await act(async () => option('Watercolor Orca').props.onPress())
    await act(async () => option('Classic Orca').props.onPress())
    expect(switcher.saveAppIcon.mock.calls).toEqual([['blue']])
    await act(async () => resolveBlue())
    expect(switcher.saveAppIcon.mock.calls).toEqual([['blue'], ['classic']])
    expect(checkedLabel()).toBe('Classic Orca')
  })

  it('disables every option when the device cannot switch icons', async () => {
    switcher.loadAppIcon.mockResolvedValue({ supported: false, iconId: 'classic' })
    await render()
    const options = renderer.root.findAll((node) => node.props.accessibilityRole === 'radio')
    expect(options.every((node) => node.props.disabled)).toBe(true)
  })
})
