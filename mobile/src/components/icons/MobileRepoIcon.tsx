import {
  Bot,
  Box,
  Braces,
  Briefcase,
  Building2,
  Code2,
  Cpu,
  Database,
  Folder,
  Gauge,
  Globe,
  Layers,
  Package,
  Palette,
  Rocket,
  Server,
  Shapes,
  Sparkles,
  SquareTerminal,
  Wrench
} from './icon-set'
import type { MobileIcon } from './mobile-icon'
import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../../host-screen/host-screen-reply-schema'
import { softMarkColors } from '../../../../src/shared/repository/appearance/repo-badge-color'
import { monogramFontScale } from '../../../../src/shared/repository/appearance/repo-monogram'
import { radii } from '../../theme/mobile-theme'
import { useMobileColorScheme, useMobileColors } from '../../theme/use-mobile-color-scheme'

// Desktop's repo-icon picker saves Lucide names; draw each with the phone's matching icon.
const REPO_ICONS_BY_DESKTOP_NAME: Record<string, MobileIcon> = {
  Folder,
  Code2,
  SquareTerminal,
  Bot,
  Package,
  Database,
  Globe,
  Server,
  Layers,
  Box,
  Braces,
  Briefcase,
  Building2,
  Cpu,
  Gauge,
  Palette,
  Rocket,
  Shapes,
  Sparkles,
  Wrench
}

type Props = {
  // Accept decoded catalog icon fields (type/src/label/emoji/name), not unused source; RepoIcon remains compatible.
  repoIcon?: MobileRenderableRepoIcon | null
  size?: number
  color?: string
}

// Render desktop-style custom image/emoji/icon with Folder fallback, never bare project dot.
export function MobileRepoIcon({ repoIcon, size = 14, color: colorProp }: Props) {
  const scheme = useMobileColorScheme()
  const colors = useMobileColors()
  const color = colorProp ?? colors.textSecondary
  // Keyed by src so a changed icon gets a fresh try; the page shell refuses every https load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (repoIcon?.type === 'image' && repoIcon.src !== failedSrc) {
    const { src } = repoIcon
    return (
      <Image
        source={{ uri: src }}
        style={{ width: size, height: size, borderRadius: radii.mark }}
        accessibilityLabel={repoIcon.label}
        onError={() => setFailedSrc(src)}
      />
    )
  }
  if (repoIcon?.type === 'letters') {
    // Same soft tint as desktop: a wash of the color with same-hue letters.
    const soft = softMarkColors(color, scheme)
    return (
      <View
        style={[
          styles.letters,
          { width: size, height: size, borderRadius: radii.mark, backgroundColor: soft.background }
        ]}
      >
        <Text
          style={[
            styles.lettersText,
            {
              color: soft.foreground,
              fontSize: size * monogramFontScale(repoIcon.text)
            }
          ]}
          numberOfLines={1}
        >
          {repoIcon.text}
        </Text>
      </View>
    )
  }
  if (repoIcon?.type === 'emoji') {
    return <Text style={[styles.emoji, { fontSize: size }]}>{repoIcon.emoji}</Text>
  }
  const Icon = (repoIcon?.type === 'lucide' && REPO_ICONS_BY_DESKTOP_NAME[repoIcon.name]) || Folder
  return (
    <View style={styles.glyph}>
      <Icon size={size} color={color} />
    </View>
  )
}

const styles = StyleSheet.create({
  letters: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  lettersText: {
    fontWeight: '600'
  },
  emoji: {
    textAlign: 'center'
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center'
  }
})
