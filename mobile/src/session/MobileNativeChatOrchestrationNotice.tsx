import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight, Mail } from 'lucide-react-native'
import { NATIVE_CHAT_NOTICE_COPY } from '../../../src/shared/native-chat/native-chat-notice'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileNativeChatDisclosure } from './native-chat/transcript/mobile-native-chat-disclosure-store'
import {
  toolStyles as styles,
  toolType
} from './native-chat/transcript/mobile-native-chat-tool-styles'

export function MobileNativeChatOrchestrationNotice({
  messageId,
  fontScale,
  children
}: {
  messageId: string
  fontScale: number
  children: ReactNode
}): React.JSX.Element {
  const t = useMobileTranslation()
  const [open, setOpen] = useMobileNativeChatDisclosure(`orchestration-mail:${messageId}`, false)
  const type = toolType(fontScale)
  return (
    <View>
      <Pressable
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Mail size={14 * fontScale} color={colors.textMuted} />
        <Text style={[styles.headerSentence, type.row]} numberOfLines={1}>
          {t('chat.notices.orchestrationMail', NATIVE_CHAT_NOTICE_COPY.orchestrationMail)}
        </Text>
        <ChevronRight
          size={14 * fontScale}
          color={colors.textMuted}
          style={open && styles.caretOpen}
        />
      </Pressable>
      {open ? children : null}
    </View>
  )
}
