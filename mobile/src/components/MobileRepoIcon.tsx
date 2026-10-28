import {
  Activity,
  BarChart3,
  Bell,
  Blocks,
  Book,
  Bot,
  Box,
  Braces,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  Camera,
  Cloud,
  Code2,
  Cpu,
  Database,
  FileText,
  Flag,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Guitar,
  Hammer,
  Heart,
  Layers,
  Lightbulb,
  Music,
  Package,
  Palette,
  Puzzle,
  Rocket,
  Server,
  // `Shapes` is lucide's own export name; exempted in config/oxlint-anti-slop.json.
  Shapes,
  Sparkles,
  SquareTerminal,
  Star,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react-native'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { REPO_LUCIDE_ICON_NAMES } from '../../../src/shared/repo-lucide-icon-names'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

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
  Cpu,
  Layers,
  Box,
  Braces,
  Briefcase,
  Building2,
  Palette,
  Gauge,
  Rocket,
  Shapes,
  Sparkles,
  Wrench,
  Activity,
  BarChart3,
  Bell,
  Blocks,
  Book,
  Bug,
  Calendar,
  Camera,
  Cloud,
  FileText,
  Flag,
  GitBranch,
  Guitar,
  Hammer,
  Heart,
  Lightbulb,
  Music,
  Puzzle,
  Star,
  Zap
}

for (const name of REPO_LUCIDE_ICON_NAMES) {
  if (!REPO_LUCIDE_ICONS[name]) {
    throw new Error(`MobileRepoIcon is missing lucide icon: ${name}`)
  }
}

type Props = {
  // Accept decoded catalog icon fields (type/src/label/emoji/name), not unused source; RepoIcon remains compatible.
  repoIcon?: MobileRenderableRepoIcon | null
  size?: number
  color?: string
}

// Render desktop-style custom image/emoji/lucide with Folder fallback, never bare project dot.
export function MobileRepoIcon({ repoIcon, size = 14, color = colors.textSecondary }: Props) {
  useMobileColorScheme()
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
