import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { NativeChatToolCallBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  formatToolInput,
  MAX_TOOL_DETAIL_LENGTH,
  truncateToolDetail
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-summary'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatOwnedScrollView } from '../../MobileNativeChatOwnedScrollView'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'

export function MobileNativeChatToolInvocation({
  call,
  fontScale,
  rootIdentity,
  positionKey
}: {
  call: NativeChatToolCallBlock
  fontScale: number
  rootIdentity: string
  positionKey: string
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const type = toolType(fontScale)
  const input = useMemo(() => formatToolInput(call.input), [call.input])
  const [expanded, setExpanded] = useState(false)
  const available = call.input !== null && call.input !== undefined
  return (
    <View style={styles.searchResults}>
      <Text selectable={INLINE_TEXT_SELECTION} style={[styles.codeText, type.meta]}>
        {call.name}
      </Text>
      {call.mcpIdentity ? (
        <Text selectable={INLINE_TEXT_SELECTION} style={[styles.codeText, type.meta]}>
          {`${call.mcpIdentity.server} / ${call.mcpIdentity.tool}`}
        </Text>
      ) : null}
      {available ? (
        <>
          <View style={styles.line}>
            <Text style={[styles.lineWord, type.meta]}>
              {t('chat.nativeChatToolLine.input', 'Input')}
            </Text>
            <MobileSourceCopyButton
              text={input}
              accessibilityLabel={t('chat.nativeChatToolLine.copyInput', 'Copy input')}
            />
          </View>
          <MobileNativeChatOwnedScrollView
            rootIdentity={rootIdentity}
            positionKey={positionKey}
            style={[styles.codeBox, styles.codeScroll]}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            <Text selectable={INLINE_TEXT_SELECTION} style={[styles.codeText, type.code]}>
              {expanded ? input : truncateToolDetail(input)}
            </Text>
          </MobileNativeChatOwnedScrollView>
          {!expanded && input.length > MAX_TOOL_DETAIL_LENGTH ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setExpanded(true)}
              style={styles.taskDisclosure}
            >
              <Text style={[styles.lineWord, type.meta]}>
                {t('chat.nativeChatToolLine.showFullInput', 'Show full input')}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={[styles.lineWord, type.meta]}>
          {t(
            'chat.nativeChatToolLine.inputUnavailable',
            'Input is not available in this transcript.'
          )}
        </Text>
      )}
    </View>
  )
}
