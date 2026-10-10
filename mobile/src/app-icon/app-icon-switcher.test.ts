import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_ICON_OPTIONS } from '../../../src/shared/app-icon'
import type { NativeAppIcon } from './native-app-icon'

const native = vi.hoisted((): { current: NativeAppIcon | null } => ({ current: null }))
vi.mock('./native-app-icon', () => ({
  get nativeAppIcon() {
    return native.current
  }
}))

const {
  alternateIconNameFor,
  appIconIdFromAlternateName,
  hasNativeAppIconModule,
  loadAppIcon,
  saveAppIcon
} = await import('./app-icon-switcher')

function fakeNative(overrides: Partial<NativeAppIcon> = {}): NativeAppIcon {
  return {
    supportsAlternateIcons: vi.fn().mockResolvedValue(true),
    getAlternateIconName: vi.fn().mockResolvedValue(null),
    setAlternateIconName: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

beforeEach(() => {
  native.current = null
})

describe('alternate icon names', () => {
  it('uses the primary icon for classic and a named icon set for the rest', () => {
    expect(alternateIconNameFor('classic')).toBeNull()
    expect(alternateIconNameFor('watercolor')).toBe('AppIconWatercolor')
  })

  it('round-trips every shared icon option', () => {
    for (const { id } of APP_ICON_OPTIONS) {
      expect(appIconIdFromAlternateName(alternateIconNameFor(id))).toBe(id)
    }
  })

  it('falls back to classic for a name this build does not know', () => {
    expect(appIconIdFromAlternateName('AppIconRemoved')).toBe('classic')
    expect(appIconIdFromAlternateName('SomethingElse')).toBe('classic')
  })
})

describe('without the native module', () => {
  it('hides the switcher and reports it unsupported', async () => {
    expect(hasNativeAppIconModule()).toBe(false)
    await expect(loadAppIcon()).resolves.toEqual({ supported: false, iconId: 'classic' })
    await expect(saveAppIcon('blue')).rejects.toThrow('not supported')
  })
})

describe('with the native module', () => {
  it('reads the current icon from the OS', async () => {
    native.current = fakeNative({
      getAlternateIconName: vi.fn().mockResolvedValue('AppIconBlue')
    })
    expect(hasNativeAppIconModule()).toBe(true)
    await expect(loadAppIcon()).resolves.toEqual({ supported: true, iconId: 'blue' })
  })

  it('reports unsupported without reading the name when the OS disallows switching', async () => {
    const getAlternateIconName = vi.fn()
    native.current = fakeNative({
      supportsAlternateIcons: vi.fn().mockResolvedValue(false),
      getAlternateIconName
    })
    await expect(loadAppIcon()).resolves.toEqual({ supported: false, iconId: 'classic' })
    expect(getAlternateIconName).not.toHaveBeenCalled()
  })

  it('switches to a named icon and back to the primary one', async () => {
    const setAlternateIconName = vi.fn().mockResolvedValue(undefined)
    native.current = fakeNative({ setAlternateIconName })
    await saveAppIcon('watercolor')
    await saveAppIcon('classic')
    expect(setAlternateIconName.mock.calls).toEqual([['AppIconWatercolor'], [null]])
  })

  it('surfaces an OS refusal to the caller', async () => {
    native.current = fakeNative({
      setAlternateIconName: vi.fn().mockRejectedValue(new Error('denied'))
    })
    await expect(saveAppIcon('blue')).rejects.toThrow('denied')
  })
})
