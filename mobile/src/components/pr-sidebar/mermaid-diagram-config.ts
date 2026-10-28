import { colors, type MobileColorScheme } from '../../theme/mobile-theme'

// Suppress mermaid error SVG: render failure uses source fallback, and default error rendering leaves orphan temporary SVG in page.
export function mermaidDiagramConfig(colorScheme: MobileColorScheme) {
  return {
    startOnLoad: false,
    theme: colorScheme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    darkMode: colorScheme === 'dark',
    suppressErrorRendering: true,
    themeVariables: {
      background: colors.bgRaised,
      primaryColor: colors.bgPanel,
      primaryTextColor: colors.textPrimary,
      lineColor: colors.textSecondary,
      textColor: colors.textPrimary
    }
  } as const
}
