import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { splitAutomationRunMessage } from '../../../../../src/shared/automation-run-preamble'
import { deriveNativeChatRowContent } from '../../../../../src/shared/native-chat-row-content'
import { isImageRefBlock, type NativeChatBlock } from '../../../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatLongPressContent } from '../../MobileNativeChatLongPressContent'
import type { useMobileNativeChatFullMessage } from '../../MobileNativeChatFullContent'
import { CHAT_PROSE_SCALE, styles as messageStyles } from './mobile-native-chat-message-styles'
import { MobileNativeChatUserMessageFold } from './MobileNativeChatUserMessageFold'

export function MobileNativeChatUserMessageBubble({
  blocks,
  fontScale,
  open,
  onToggle,
  recovery,
  status,
  onOpenFile,
  onLongPress,
  renderProse,
  children
}: {
  renderProse: (blocks: NativeChatBlock[]) => React.ReactNode
  children?: React.ReactNode
  blocks: NativeChatBlock[]
  fontScale: number
  open: boolean
  onToggle: () => void
  recovery?: ReturnType<typeof useMobileNativeChatFullMessage>['recovery']
  status?: React.ReactNode
  onOpenFile?: (path: string) => void
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const markdown = deriveNativeChatRowContent(blocks).markdown
  const automation = splitAutomationRunMessage(markdown)
  const task = automation?.task ?? markdown
  return (
    <>
      {automation ? (
        <Pressable
          style={styles.toggle}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ expanded: instructionsOpen }}
          onPress={() => setInstructionsOpen(!instructionsOpen)}
        >
          <View style={instructionsOpen ? messageStyles.reasoningCaretOpen : undefined}>
            <ChevronRight size={12} color={colors.textMuted} />
          </View>
          <Text style={styles.label}>
            {t(
              'components.native-chat.userMessage.automationInstructions',
              'Automation instructions'
            )}
          </Text>
        </Pressable>
      ) : null}
      <MobileNativeChatLongPressContent
        onLongPress={onLongPress}
        style={[messageStyles.content, messageStyles.userBubble]}
      >
        {automation && instructionsOpen ? (
          <View style={styles.instructions}>
            <View style={styles.faint}>
              <MobileMarkdown
                content={automation.instructions}
                tone="userMessage"
                rangeSelectable
                textScale={CHAT_PROSE_SCALE * fontScale}
                onOpenFile={onOpenFile}
                onLongPress={onLongPress}
              />
            </View>
          </View>
        ) : null}
        {renderProse(blocks.filter(isImageRefBlock))}
        <MobileNativeChatUserMessageFold
          text={task}
          fontScale={fontScale}
          open={open}
          onToggle={onToggle}
          recovery={recovery}
          status={status}
        >
          {automation ? (
            <MobileMarkdown
              content={task}
              tone="userMessage"
              rangeSelectable
              textScale={CHAT_PROSE_SCALE * fontScale}
              onOpenFile={onOpenFile}
              onLongPress={onLongPress}
            />
          ) : (
            renderProse(blocks.filter((block) => !isImageRefBlock(block)))
          )}
        </MobileNativeChatUserMessageFold>
        {children}
      </MobileNativeChatLongPressContent>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32
  },
  label: { color: colors.textMuted, fontSize: typography.metaSize },
  instructions: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.chatUserBorder,
    paddingBottom: spacing.md,
    marginBottom: spacing.xs
  },
  faint: { opacity: 0.7 }
}))
