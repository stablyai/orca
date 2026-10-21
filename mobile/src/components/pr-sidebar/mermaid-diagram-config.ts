import { colors } from '../../theme/mobile-theme'

/**
 * The mermaid configuration the page hands to `mermaid.initialize`.
 *
 * `suppressErrorRendering` because a diagram that throws is a source box: without it
 * mermaid draws its own error diagram into a temporary element and then leaves that element in the
 * document as it rethrows, which on the page is an orphan SVG under nobody's mount.
 */
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
