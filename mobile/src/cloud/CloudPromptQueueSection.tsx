import { Lock, RotateCw, X } from 'lucide-react-native'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { cloudAgentLabel } from './CloudAgentPicker'
import { removeCloudPrompt, retryCloudPrompt, type QueuedCloudPrompt } from './cloud-prompt-queue'
import { cloudPromptErrorMessage } from './cloud-workspace-copy'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/** Prompts held on this phone until the workspace is awake; each can be retried or removed. */
export function CloudPromptQueueSection(props: {
  queue: QueuedCloudPrompt[]
  /** Awake prompts wait on this phone's connection, not on the workspace. */
  awake: boolean
  onRetry: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (props.queue.length === 0) {
    return null
  }
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading} accessibilityRole="header">
        {t('cloud.prompt.queued', 'Waiting to send')}
      </Text>
      <View style={styles.card}>
        {props.queue.map((prompt, index) => {
          const failed = prompt.status === 'failed'
          const state = failed
            ? t('cloud.prompt.notSent', 'Not sent: {{reason}}', {
                reason: cloudPromptErrorMessage(prompt.error, t)
              })
            : prompt.status === 'delivering'
              ? t('cloud.prompt.delivering', 'Sending…')
              : props.awake
                ? t('cloud.prompt.waitingConnect', 'Waiting to connect')
                : t('cloud.prompt.waiting', 'Sends when the workspace wakes')
          const retry = () => void retryCloudPrompt(prompt.id).then(props.onRetry)
          const remove = () => void removeCloudPrompt(prompt.id)
          return (
            <View
              key={prompt.id}
              style={[styles.queueRow, index > 0 && styles.queueRowDivider]}
              accessible
              accessibilityLabel={`${cloudAgentLabel(prompt.agent)}: ${prompt.text}. ${state}`}
              accessibilityActions={[
                ...(failed ? [{ name: 'retry', label: t('common.tryAgain', 'Try again') }] : []),
                { name: 'delete', label: t('cloud.prompt.remove', 'Remove') }
              ]}
              onAccessibilityAction={(event) =>
                event.nativeEvent.actionName === 'retry' ? retry() : remove()
              }
            >
              <View style={styles.queueText}>
                <Text style={styles.queuePrompt} numberOfLines={3}>
                  {prompt.text}
                </Text>
                <Text style={[styles.queueState, failed && styles.queueStateFailed]}>
                  {`${cloudAgentLabel(prompt.agent)} · ${state}`}
                </Text>
              </View>
              {prompt.status === 'delivering' ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <View style={styles.queueButtons} importantForAccessibility="no-hide-descendants">
                  {failed ? (
                    <Pressable onPress={retry} hitSlop={6} style={styles.iconButton}>
                      <RotateCw size={17} color={colors.accentBlue} />
                    </Pressable>
                  ) : null}
                  <Pressable onPress={remove} hitSlop={6} style={styles.iconButton}>
                    <X size={18} color={colors.textMuted} />
                  </Pressable>
                </View>
              )}
            </View>
          )
        })}
        {props.awake ? null : (
          <View style={[styles.queueRow, styles.queueRowDivider, styles.queueNote]}>
            <Lock size={13} color={colors.textMuted} />
            <Text style={styles.caption}>
              {t(
                'cloud.prompt.queuedNote',
                'Kept on this phone until the workspace is awake, then sent end-to-end encrypted.'
              )}
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
