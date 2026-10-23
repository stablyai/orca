import { memo, type ComponentType } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import {
  Bold,
  Code2,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  Strikethrough
} from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion, radii, spacing } from '../theme/mobile-theme'
import { pressTransition } from './ui/transition-styles'
import type { MobileRichMarkdownCommand } from './mobile-rich-markdown-editor-contract'

type ToolbarItem = {
  command: MobileRichMarkdownCommand
  label: string
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
}

/**
 * The fifteen commands, in the order they are pressed in.
 *
 * Shared rather than declared twice because both surfaces drive the same document: inside the
 * WebView the press becomes an injected `runCommand` and on the page it is a call, but the row of
 * controls is the same row and a command added to the contract has to appear on both.
 */
const TOOLBAR_ITEMS: ToolbarItem[] = [
  { command: 'paragraph', label: 'Body', icon: Pilcrow },
  { command: 'heading1', label: 'H1', icon: Heading1 },
  { command: 'heading2', label: 'H2', icon: Heading2 },
  { command: 'heading3', label: 'H3', icon: Heading3 },
  { command: 'bold', label: 'Bold', icon: Bold },
  { command: 'italic', label: 'Italic', icon: Italic },
  { command: 'strike', label: 'Strike', icon: Strikethrough },
  { command: 'bulletList', label: 'Bullet list', icon: List },
  { command: 'orderedList', label: 'Numbered list', icon: ListOrdered },
  { command: 'taskList', label: 'Checklist', icon: ListTodo },
  { command: 'quote', label: 'Quote', icon: Quote },
  { command: 'link', label: 'Link', icon: Link },
  { command: 'image', label: 'Image', icon: ImageIcon },
  { command: 'inlineCode', label: 'Inline code', icon: Code2 },
  { command: 'codeBlock', label: 'Code block', icon: FileCode2 }
]

/** The commands alone, for a caller that drives the row rather than renders it. */
export const MOBILE_RICH_MARKDOWN_TOOLBAR_COMMANDS = TOOLBAR_ITEMS.map((item) => item.command)

export const MobileRichMarkdownToolbar = memo(function MobileRichMarkdownToolbar({
  editable,
  onCommand
}: {
  editable: boolean
  onCommand: (command: MobileRichMarkdownCommand) => void
}) {
  return (
    <View style={styles.toolbar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.toolbarContent}
        keyboardShouldPersistTaps="handled"
      >
        {TOOLBAR_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <Pressable
              key={item.command}
              disabled={!editable}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              onPress={() => onCommand(item.command)}
              style={[styles.toolbarTouch, !editable ? styles.toolbarButtonDisabled : null]}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.toolbarButton,
                    pressed && editable ? styles.toolbarButtonPressed : null,
                    pressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  <Icon
                    size={17}
                    color={editable ? colors.textPrimary : colors.textMuted}
                    strokeWidth={2.2}
                  />
                </View>
              )}
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
})

const styles = StyleSheet.create({
  toolbar: {
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    backgroundColor: colors.bgBase
  },
  toolbarContent: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  // 44 pt to tap, 36 pt to see: the circle is what reads as a button.
  toolbarTouch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toolbarButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill
  },
  toolbarButtonPressed: {
    backgroundColor: colors.fillPressed
  },
  toolbarButtonDisabled: {
    opacity: motion.disabledOpacity
  }
})
