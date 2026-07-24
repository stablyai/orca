import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { useColorScheme } from 'react-native'
import {
  DEFAULT_APP_THEME,
  loadAppTheme,
  saveAppTheme,
  type MobileAppTheme
} from '../storage/preferences'
import { darkColors, lightColors, type ThemeColors } from './mobile-theme'

export type ResolvedThemeMode = 'dark' | 'light'

export type MobileThemeValue = {
  readonly mode: ResolvedThemeMode
  readonly colors: ThemeColors
  readonly preference: MobileAppTheme
  readonly setAppTheme: (next: MobileAppTheme) => void
}

export function resolveThemeMode(
  preference: MobileAppTheme,
  // ColorSchemeName also admits 'unspecified' on some RN versions; treat anything
  // other than 'light' as dark (desktop no-matchMedia bias).
  systemScheme: string | null | undefined
): ResolvedThemeMode {
  if (preference !== 'system') {
    return preference
  }
  // Why: mirrors desktop's getSystemPrefersDark(), which returns true when the OS
  // preference is unreadable — src/renderer/src/lib/terminal-theme.ts:37-42.
  return systemScheme === 'light' ? 'light' : 'dark'
}

// Why: a default value (not `undefined` + throw) keeps every component rendered
// outside the provider — all existing react-test-renderer suites — rendering as today.
const defaultThemeValue: MobileThemeValue = {
  mode: 'dark',
  colors: darkColors,
  preference: DEFAULT_APP_THEME,
  setAppTheme: () => undefined
}

const ThemeContext = createContext<MobileThemeValue>(defaultThemeValue)

// One sheet per (factory, palette). Both palettes are module constants, so the
// inner Map holds at most 2 entries per factory for the process lifetime.
const themedStyleCache = new WeakMap<object, Map<ThemeColors, unknown>>()

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const systemScheme = useColorScheme()
  const [preference, setPreference] = useState<MobileAppTheme>(DEFAULT_APP_THEME)

  useEffect(() => {
    let cancelled = false
    void loadAppTheme().then((stored) => {
      if (!cancelled) {
        setPreference(stored)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setAppTheme = useCallback((next: MobileAppTheme) => {
    setPreference(next)
    void saveAppTheme(next)
  }, [])

  const mode = resolveThemeMode(preference, systemScheme)
  const colors = mode === 'light' ? lightColors : darkColors

  const value = useMemo<MobileThemeValue>(
    () => ({ mode, colors, preference, setAppTheme }),
    [mode, colors, preference, setAppTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): MobileThemeValue {
  return useContext(ThemeContext)
}

/** Module-scope factories only — an inline arrow is a fresh cache key every render. */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme()
  // Why key on colors (not the whole context value): preference flips that do not
  // change the resolved palette share the same sheet object.
  let byPalette = themedStyleCache.get(factory)
  if (!byPalette) {
    byPalette = new Map()
    themedStyleCache.set(factory, byPalette)
  }
  let sheet = byPalette.get(colors) as T | undefined
  if (sheet === undefined) {
    sheet = factory(colors)
    byPalette.set(colors, sheet)
  }
  return sheet
}
