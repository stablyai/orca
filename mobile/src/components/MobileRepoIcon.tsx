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
  type LucideIcon,
  Package,
  Palette,
  Rocket,
  Server,
  // `Shapes` is lucide's own export name; exempted in config/oxlint-anti-slop.json.
  Shapes,
  Sparkles,
  SquareTerminal,
  Wrench
} from 'lucide-react-native'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { colors } from '../theme/mobile-theme'

// Match desktop repo-icon picker’s lucide glyphs so mobile project headers retain chosen icons.
const REPO_LUCIDE_ICONS: Record<string, LucideIcon> = {
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

// Render desktop-style custom image/emoji/lucide with Folder fallback, never bare project dot.
export function MobileRepoIcon({ repoIcon, size = 14, color = colors.textSecondary }: Props) {
  if (repoIcon?.type === 'image') {
    return (
      <Image
        source={{ uri: repoIcon.src }}
        style={{ width: size, height: size, borderRadius: 3 }}
        accessibilityLabel={repoIcon.label}
      />
    )
  }
  if (repoIcon?.type === 'emoji') {
    return <Text style={[styles.emoji, { fontSize: size }]}>{repoIcon.emoji}</Text>
  }
  const Icon = (repoIcon?.type === 'lucide' && REPO_LUCIDE_ICONS[repoIcon.name]) || Folder
  return (
    <View style={styles.glyph}>
      <Icon size={size} color={color} strokeWidth={2} />
    </View>
  )
}

const styles = StyleSheet.create({
  emoji: {
    textAlign: 'center'
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center'
  }
})
