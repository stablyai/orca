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
  Shapes,
  Sparkles,
  SquareTerminal,
  Wrench
} from 'lucide-react-native'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { colors } from '../theme/mobile-theme'

// The lucide names the desktop repo-icon picker offers (src/renderer/src/
// components/repo/repo-icon.tsx). Mobile renders the same glyph so the project
// header icon matches desktop instead of a bare colored dot.
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
  repoIcon?: RepoIcon | null
  size?: number
  color?: string
}

// Renders a repo/project icon matching the desktop sidebar: a custom image
// (favicon/avatar/upload), an emoji, or a lucide glyph. Falls back to Folder,
// the desktop default, so a project always shows an icon rather than a dot.
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
