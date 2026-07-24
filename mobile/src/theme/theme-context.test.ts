import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeColors } from './mobile-theme'
import { darkColors, lightColors } from './mobile-theme'

const useColorSchemeMock = vi.fn((): 'dark' | 'light' | null | undefined => 'dark')

vi.mock('react-native', () => ({
  useColorScheme: () => useColorSchemeMock(),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(sheet: T): T => sheet
  }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined)
  }
}))

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

const restoreConsoleError = suppressReactTestRendererDeprecationWarning()

const createProbeStyles = (colors: ThemeColors) => ({
  root: { backgroundColor: colors.bgBase }
})

describe('resolveThemeMode', () => {
  it('returns the explicit preference for dark and light', async () => {
    const { resolveThemeMode } = await import('./theme-context')
    expect(resolveThemeMode('dark', 'light')).toBe('dark')
    expect(resolveThemeMode('light', 'dark')).toBe('light')
  })

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    [null, 'dark'],
    [undefined, 'dark']
  ] as const)(
    'resolves system + %s with the desktop no-matchMedia dark bias',
    async (scheme, expected) => {
      const { resolveThemeMode } = await import('./theme-context')
      // Why: mirrors getSystemPrefersDark at terminal-theme.ts:37-42 (null/undefined → dark).
      expect(resolveThemeMode('system', scheme)).toBe(expected)
    }
  )
})

describe('useThemedStyles cache', () => {
  beforeEach(() => {
    useColorSchemeMock.mockReturnValue('dark')
    vi.resetModules()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    restoreConsoleError()
  })

  it('shares one sheet object across instances and reuses it after a round-trip flip', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default
    vi.mocked(storage.getItem).mockResolvedValue(null)
    const { ThemeProvider, useThemedStyles, useTheme } = await import('./theme-context')

    type Capture = {
      sheet: { root: { backgroundColor: string } }
      mode: string
      setAppTheme: (n: 'system' | 'dark' | 'light') => void
    }
    let first: Capture | null = null
    let second: Capture | null = null

    function ProbeA() {
      const sheet = useThemedStyles(createProbeStyles)
      const { mode, setAppTheme } = useTheme()
      first = { sheet, mode, setAppTheme }
      return null
    }
    function ProbeB() {
      const sheet = useThemedStyles(createProbeStyles)
      const { mode, setAppTheme } = useTheme()
      second = { sheet, mode, setAppTheme }
      return null
    }

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(ThemeProvider, null, createElement(ProbeA), createElement(ProbeB))
      )
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.sheet).toBe(second!.sheet)
    expect(first!.sheet.root.backgroundColor).toBe(darkColors.bgBase)
    const darkSheet = first!.sheet

    await act(async () => {
      first!.setAppTheme('light')
    })
    expect(first!.mode).toBe('light')
    expect(first!.sheet).not.toBe(darkSheet)
    expect(first!.sheet.root.backgroundColor).toBe(lightColors.bgBase)
    expect(first!.sheet).toBe(second!.sheet)
    const lightSheet = first!.sheet

    await act(async () => {
      first!.setAppTheme('dark')
    })
    expect(first!.mode).toBe('dark')
    // Why: proves the 2-entry cache, not a rebuild on every flip.
    expect(first!.sheet).toBe(darkSheet)
    expect(first!.sheet).not.toBe(lightSheet)
    expect(first!.sheet).toBe(second!.sheet)

    await act(async () => {
      renderer.unmount()
    })
  })
})
