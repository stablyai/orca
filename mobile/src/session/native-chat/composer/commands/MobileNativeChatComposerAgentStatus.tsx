import { Text } from 'react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { MobileNativeChatSessionOptionsController } from '../../input/session-options/use-mobile-native-chat-session-options'
import { mobileNativeChatComposerStyles as styles } from '../field/mobile-native-chat-composer-styles'

export function MobileNativeChatComposerAgentStatus({
  options
}: {
  options?: { controller: MobileNativeChatSessionOptionsController } | null
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const agent = options?.controller.snapshot.find(
    (entry) => entry.id === 'interactionMode'
  )?.reportedAgent
  return agent ? (
    <Text style={styles.activeAgent} numberOfLines={1}>
      {t('components.native-chat.composer.activeAgent', 'Active: {{agent}}', { agent: agent.name })}
    </Text>
  ) : null
}
