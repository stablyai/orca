import { colors, type MobileColorScheme } from '../../theme/mobile-theme'

// Suppress mermaid error SVG: render failure uses source fallback, and default error rendering leaves orphan temporary SVG in page.
export function mermaidDiagramConfig(colorScheme: MobileColorScheme) {
  return {
    startOnLoad: false,
    theme: colorScheme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    darkMode: colorScheme === 'dark',
    suppressErrorRendering: true,
    // The page's own text face; mermaid defaults to Trebuchet.
    fontFamily: 'system-ui, sans-serif',
    themeVariables: {
      background: colors.bgRaised,
      primaryColor: colors.bgPanel,
      primaryBorderColor: colors.borderSubtle,
      nodeBorder: colors.borderSubtle,
      primaryTextColor: colors.textPrimary,
      lineColor: colors.textSecondary,
      textColor: colors.textPrimary
    }
  } as const
}
