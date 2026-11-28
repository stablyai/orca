import { useState } from 'react'
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { typography } from '../../../../theme/mobile-theme'
import { INLINE_TEXT_SELECTION } from '../../../../platform/text-selection/inline-text-selection'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticeDisclosure } from './MobileNativeChatNoticeDisclosure'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

export function MobileNativeChatGoalCheckNotice({
  text,
  fontScale,
  onLongPress
}: {
  text: string
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const newline = text.indexOf('\n')
  return (
    <View>
      <MobileNativeChatNoticeDisclosure
        summary={t('chat.goal.checks', '{{count}} checks', {
          count: Number(text.slice(0, newline)),
          defaultValue_one: '{{count}} check'
        })}
        expanded={expanded}
        fontScale={fontScale}
        onPress={() => setExpanded((open) => !open)}
        onLongPress={onLongPress}
      />
      {expanded ? (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[{ color: colors.textMuted }, scaledType(typography.bodySize, fontScale)]}
        >
          {text.slice(newline + 1)}
        </Text>
      ) : null}
    </View>
  )
}
