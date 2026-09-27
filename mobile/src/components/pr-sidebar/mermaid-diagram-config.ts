import { colors } from '../../theme/mobile-theme'

/**
 * The one mermaid configuration both hosts run.
 *
 * The native document splices it into the inline script it builds; the page hands the same object
 * to `mermaid.initialize`. Written down twice these would drift, and the drift would be a diagram
 * that looks different on the page from the one on the phone.
 *
 * `suppressErrorRendering` because a diagram that throws is a source box on both hosts: without it
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
