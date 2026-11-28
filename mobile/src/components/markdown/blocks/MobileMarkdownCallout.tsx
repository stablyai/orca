import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert
} from 'lucide-react-native'
import type { GitHubCalloutKind } from '../../../../../src/shared/github/markdown/github-callouts'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { stylesSheet } from '../mobile-markdown-styles'
import { useThemedStyles } from '../../../theme/themed-styles'
import type { MobilePalette } from '../../../theme/mobile-theme'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'

// Desktop's markdown-github-callout.tsx in the phone's tokens.
const CALLOUTS: Record<
  GitHubCalloutKind,
  { color: (colors: MobilePalette) => string; label: (t: Translate) => string }
> = {
  note: {
    color: (colors) => colors.accentBlue,
    label: (t) => t('components.markdownCallout.note', 'Note')
  },
  tip: {
    color: (colors) => colors.statusGreen,
    label: (t) => t('components.markdownCallout.tip', 'Tip')
  },
  important: {
    color: (colors) => colors.statusPurple,
    label: (t) => t('components.markdownCallout.important', 'Important')
  },
  warning: {
    color: (colors) => colors.statusAmber,
    label: (t) => t('components.markdownCallout.warning', 'Warning')
  },
  caution: {
    color: (colors) => colors.statusRed,
    label: (t) => t('components.markdownCallout.caution', 'Caution')
  }
}

function CalloutIcon({
  kind,
  color,
  size
}: {
  kind: GitHubCalloutKind
  color: string
  size: number
}) {
  const icon = { size, color, strokeWidth: 2.2 }
  switch (kind) {
    case 'note':
      return <Info {...icon} />
    case 'tip':
      return <Lightbulb {...icon} />
    case 'important':
      return <MessageSquareWarning {...icon} />
    case 'warning':
      return <TriangleAlert {...icon} />
    case 'caution':
      return <OctagonAlert {...icon} />
  }
}

/** A GitHub alert (`> [!NOTE]`): its kind's colour, icon and title over ordinary body text. */
export function MobileMarkdownCallout({
  kind,
  textScale,
  children
}: {
  kind: GitHubCalloutKind
  textScale: number
  children: ReactNode
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const callout = CALLOUTS[kind]
  const color = callout.color(colors)
  return (
    <View style={[styles.callout, { borderLeftColor: color }]}>
      <View style={styles.calloutTitle}>
        <CalloutIcon kind={kind} color={color} size={14 * textScale} />
        <Text
          style={[
            styles.calloutTitleText,
            { color: color, fontSize: styles.calloutTitleText.fontSize * textScale }
          ]}
        >
          {callout.label(t)}
        </Text>
      </View>
      {children}
    </View>
  )
}
