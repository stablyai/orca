import { createThemedStyles } from '../../theme/mobile-themed-styles'
import { colors, getMobileColorScheme, typography } from '../../theme/mobile-theme'

/**
 * The mermaid configuration the page hands to `mermaid.initialize`.
 *
 * `suppressErrorRendering` because a diagram that throws is a source box: without it
 * mermaid draws its own error diagram into a temporary element and then leaves that element in the
 * document as it rethrows, which on the page is an orphan SVG under nobody's mount.
 */
export const MERMAID_DIAGRAM_CONFIG = createThemedStyles(
  () =>
    ({
      startOnLoad: false,
      theme: 'base',
      fontFamily: 'system-ui, sans-serif',
      securityLevel: 'strict',
      darkMode: getMobileColorScheme() === 'dark',
      suppressErrorRendering: true,
      themeVariables: {
        darkMode: getMobileColorScheme() === 'dark',
        fontSize: `${typography.bodySize}px`,
        background: colors.bgRaised,
        primaryColor: colors.bgPanel,
        primaryBorderColor: colors.borderSubtle,
        primaryTextColor: colors.textPrimary,
        secondaryColor: colors.bgRaised,
        tertiaryColor: colors.bgPanel,
        clusterBkg: colors.bgRaised,
        clusterBorder: colors.borderSubtle,
        edgeLabelBackground: colors.bgRaised,
        actorBkg: colors.bgPanel,
        actorBorder: colors.borderSubtle,
        actorTextColor: colors.textPrimary,
        actorLineColor: colors.textMuted,
        signalColor: colors.textSecondary,
        signalTextColor: colors.textPrimary,
        noteBkgColor: colors.bgRaised,
        noteBorderColor: colors.borderSubtle,
        noteTextColor: colors.textPrimary,
        lineColor: colors.textSecondary,
        textColor: colors.textPrimary,
        attributeBackgroundColorOdd: colors.bgPanel,
        attributeBackgroundColorEven: colors.bgRaised,
        altSectionBkgColor: colors.bgRaised,
        excludeBkgColor: colors.bgBase,
        doneTaskBkgColor: colors.bgPanel,
        activeTaskBkgColor: colors.bgRaised,
        taskTextDarkColor: colors.textPrimary
      }
    }) as const
)
