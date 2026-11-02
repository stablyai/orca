import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { MoreHorizontal, Plus } from 'lucide-react-native'
import { MobileRepoIcon } from '../components/MobileRepoIcon'
import { readMobileRepoIcon } from './host-screen-reply-schema'
import { colors } from '../theme/mobile-theme'
import { conversationStyles as styles } from './conversation-styles'
import { conversationCopy } from './conversation-copy'
import type { ConversationProject } from './project-conversations'

export function ConversationProjectHeader({
  project,
  connected,
  busy,
  onPrepare,
  onOptions
}: {
  project: ConversationProject
  connected: boolean
  busy: string | null
  onPrepare: () => void
  onOptions: () => void
}) {
  const copy = conversationCopy()
  const canStart =
    connected && !project.hostHealthLabel && busy === null && project.workspaces.length > 0
  return (
    <View style={styles.section}>
      <MobileRepoIcon repoIcon={readMobileRepoIcon(project.repo?.repoIcon)} size={16} />
      <View style={styles.sectionName}>
        <Text style={styles.projectTitle} numberOfLines={1}>
          {project.title}
        </Text>
        {project.hostLabel || project.hostHealthLabel ? (
          <Text style={styles.meta}>
            {[project.hostLabel, project.hostHealthLabel].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onOptions}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={`${copy.projectOptions}: ${project.title}`}
      >
        <MoreHorizontal size={18} color={colors.textSecondary} />
      </Pressable>
      {project.workspaces.length > 0 ? (
        <Pressable
          onPress={onPrepare}
          disabled={!canStart}
          style={[styles.newChat, !canStart && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel={`${copy.newChat}: ${project.title}`}
        >
          {busy === project.key ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Plus size={16} color={colors.textPrimary} />
          )}
          <Text style={styles.actionText}>{copy.newChat}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
