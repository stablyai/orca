import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadThemePreference, saveThemePreference } from '../storage/preferences'
import { ThemeProvider, useTheme, useThemedStyles, type ThemePreference } from './theme-context'
import type { ThemeColors } from './mobile-theme'

vi.mock('react-native', () => ({
  useColorScheme: () => 'dark'
}))

vi.mock('../storage/preferences', () => ({
  loadThemePreference: vi.fn(),
  saveThemePreference: vi.fn()
}))

type TestStyles = {
  marker: {
    color: string
  }
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(element)
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('ThemeProvider did not render')
  }
  return renderer
}

function createStyleFactory(): ReturnType<typeof vi.fn<(colors: ThemeColors) => TestStyles>> {
  return vi.fn((colors: ThemeColors): TestStyles => ({ marker: { color: colors.textPrimary } }))
}

describe('useThemedStyles', () => {
  beforeEach(() => {
    vi.mocked(loadThemePreference).mockReset()
    vi.mocked(saveThemePreference).mockReset()
    vi.mocked(loadThemePreference).mockResolvedValue('dark')
    vi.mocked(saveThemePreference).mockResolvedValue(undefined)
  })

  it('shares one factory result across component instances using the same palette', async () => {
    const factory = createStyleFactory()
    const receivedStyles: TestStyles[] = []

    function Consumer(): null {
      receivedStyles.push(useThemedStyles(factory))
      return null
    }

    const renderer = await render(
      createElement(
        ThemeProvider,
        null,
        createElement(Consumer, { key: 'one' }),
        createElement(Consumer, { key: 'two' }),
        createElement(Consumer, { key: 'three' })
      )
    )

    expect(receivedStyles[0]).toBe(receivedStyles[1])
    expect(new Set(receivedStyles)).toHaveLength(1)
    expect(factory).toHaveBeenCalledTimes(1)

    renderer.unmount()
  })

  it('caches separate palette results and reuses the original when switching back', async () => {
    const factory = createStyleFactory()
    const receivedStyles: TestStyles[] = []
    let setPreference: ((preference: ThemePreference) => void) | null = null

    function Controller(): null {
      receivedStyles.push(useThemedStyles(factory))
      setPreference = useTheme().setPreference
      return null
    }

    const renderer = await render(createElement(ThemeProvider, null, createElement(Controller)))
    const darkStyles = receivedStyles[receivedStyles.length - 1]
    if (!setPreference) {
      throw new Error('Theme preference setter was not captured')
    }

    await act(async () => {
      setPreference?.('light')
      await Promise.resolve()
    })
    const lightStyles = receivedStyles[receivedStyles.length - 1]

    expect(lightStyles).not.toBe(darkStyles)
    expect(factory).toHaveBeenCalledTimes(2)

    await act(async () => {
      setPreference?.('dark')
      await Promise.resolve()
    })
    const darkStylesAgain = receivedStyles[receivedStyles.length - 1]

    expect(darkStylesAgain).toBe(darkStyles)
    expect(factory).toHaveBeenCalledTimes(2)

    renderer.unmount()
  })
})
