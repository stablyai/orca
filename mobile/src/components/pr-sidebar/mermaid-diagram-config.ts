import { colors } from '../../theme/mobile-theme'

// Suppress mermaid error SVG: render failure uses source fallback, and default error rendering leaves orphan temporary SVG in page.
export const MERMAID_DIAGRAM_CONFIG = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  darkMode: true,
  suppressErrorRendering: true,
  themeVariables: {
    background: colors.bgRaised,
    primaryColor: colors.bgPanel,
    primaryTextColor: colors.textPrimary,
    lineColor: colors.textSecondary,
    textColor: colors.textPrimary
  }
} as const
