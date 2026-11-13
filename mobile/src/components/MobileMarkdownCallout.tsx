import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert
} from 'lucide-react-native'
import type { GitHubCalloutKind } from '../../../src/shared/github/markdown/github-callouts'
import { translate } from '../i18n/mobile-i18n'
import { styles } from './mobile-markdown-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Desktop's markdown-github-callout.tsx in the phone's tokens.
const CALLOUTS: Record<GitHubCalloutKind, { color: () => string; label: () => string }> = {
  note: {
    color: () => colors.accentBlue,
    label: () => translate('components.markdownCallout.note', 'Note')
  },
  tip: {
    color: () => colors.statusGreen,
    label: () => translate('components.markdownCallout.tip', 'Tip')
  },
  important: {
    color: () => colors.statusPurple,
    label: () => translate('components.markdownCallout.important', 'Important')
  },
  warning: {
    color: () => colors.statusAmber,
    label: () => translate('components.markdownCallout.warning', 'Warning')
  },
  caution: {
    color: () => colors.statusRed,
    label: () => translate('components.markdownCallout.caution', 'Caution')
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
  useMobileColorScheme()
  const { color, label } = CALLOUTS[kind]
  return (
    <View style={[styles.callout, { borderLeftColor: color() }]}>
      <View style={styles.calloutTitle}>
        <CalloutIcon kind={kind} color={color()} size={14 * textScale} />
        <Text
          style={[
            styles.calloutTitleText,
            { color: color(), fontSize: styles.calloutTitleText.fontSize * textScale }
          ]}
        >
          {label()}
        </Text>
      </View>
      {children}
    </View>
  )
}
