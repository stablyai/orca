import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useColorScheme } from 'react-native'
import { loadThemePreference, saveThemePreference } from '../storage/preferences'
import { darkColors, lightColors, type ThemeColors } from './mobile-theme'

export type ThemePreference = 'system' | 'light' | 'dark'

type ThemeContextValue = {
  colors: ThemeColors
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

type ThemedStylesFactory = (colors: ThemeColors) => unknown

const ThemeContext = createContext<ThemeContextValue | null>(null)
const themedStylesCache = new WeakMap<ThemedStylesFactory, Map<ThemeColors, unknown>>()

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const systemScheme = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('dark')
  const [loaded, setLoaded] = useState(false)
  const userSelectedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void loadThemePreference().then((storedPreference) => {
      if (!cancelled && !userSelectedRef.current) {
        setPreferenceState(storedPreference)
      }
      if (!cancelled) {
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    userSelectedRef.current = true
    setPreferenceState(nextPreference)
    void saveThemePreference(nextPreference)
  }, [])

  const resolvedPreference = loaded ? preference : 'dark'
  const colors =
    resolvedPreference === 'system'
      ? systemScheme === 'light'
        ? lightColors
        : darkColors
      : resolvedPreference === 'light'
        ? lightColors
        : darkColors

  const value = useMemo(
    () => ({ colors, preference, setPreference }),
    [colors, preference, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('useTheme must be used inside ThemeProvider')
  }
  return value
}

export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme()
  let stylesByColors = themedStylesCache.get(factory)
  if (!stylesByColors) {
    stylesByColors = new Map<ThemeColors, unknown>()
    themedStylesCache.set(factory, stylesByColors)
  }
  if (stylesByColors.has(colors)) {
    return stylesByColors.get(colors) as T
  }
  // Why: row-heavy screens should share sheets like the old module-scope
  // StyleSheet.create; per-instance useMemo allocated one sheet per row.
  const styles = factory(colors)
  stylesByColors.set(colors, styles)
  return styles
}
