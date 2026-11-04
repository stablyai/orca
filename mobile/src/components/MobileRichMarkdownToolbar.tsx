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
import { colors, radii, spacing } from '../theme/mobile-theme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileRichMarkdownCommand } from './mobile-rich-markdown-editor-contract'

type ToolbarItem = {
  command: MobileRichMarkdownCommand
  label: (t: Translate) => string
  icon: ComponentType<{ size?: number; color?: string }>
}

// Share command row across native injected runCommand and direct page calls so contract additions appear on both surfaces.
const TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    command: 'paragraph',
    label: (t) => t('components.richMarkdownToolbar.body', 'Body'),
    icon: Pilcrow
  },
  {
    command: 'heading1',
    label: (t) => t('components.richMarkdownToolbar.heading1', 'H1'),
    icon: Heading1
  },
  {
    command: 'heading2',
    label: (t) => t('components.richMarkdownToolbar.heading2', 'H2'),
    icon: Heading2
  },
  {
    command: 'heading3',
    label: (t) => t('components.richMarkdownToolbar.heading3', 'H3'),
    icon: Heading3
  },
  {
    command: 'bold',
    label: (t) => t('components.richMarkdownToolbar.bold', 'Bold'),
    icon: Bold
  },
  {
    command: 'italic',
    label: (t) => t('components.richMarkdownToolbar.italic', 'Italic'),
    icon: Italic
  },
  {
    command: 'strike',
    label: (t) => t('components.richMarkdownToolbar.strike', 'Strike'),
    icon: Strikethrough
  },
  {
    command: 'bulletList',
    label: (t) => t('components.richMarkdownToolbar.bulletList', 'Bullet list'),
    icon: List
  },
  {
    command: 'orderedList',
    label: (t) => t('components.richMarkdownToolbar.numberedList', 'Numbered list'),
    icon: ListOrdered
  },
  {
    command: 'taskList',
    label: (t) => t('components.richMarkdownToolbar.checklist', 'Checklist'),
    icon: ListTodo
  },
  {
    command: 'quote',
    label: (t) => t('components.richMarkdownToolbar.quote', 'Quote'),
    icon: Quote
  },
  {
    command: 'link',
    label: (t) => t('components.richMarkdownToolbar.link', 'Link'),
    icon: Link
  },
  {
    command: 'image',
    label: (t) => t('components.richMarkdownToolbar.image', 'Image'),
    icon: ImageIcon
  },
  {
    command: 'inlineCode',
    label: (t) => t('components.richMarkdownToolbar.inlineCode', 'Inline code'),
    icon: Code2
  },
  {
    command: 'codeBlock',
    label: (t) => t('components.richMarkdownToolbar.codeBlock', 'Code block'),
    icon: FileCode2
  }
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
  const t = useMobileTranslation()
  useMobileColorScheme()
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
              accessibilityLabel={item.label(t)}
              onPress={() => onCommand(item.command)}
              style={({ pressed }) => [
                styles.toolbarButton,
                pressed && editable ? styles.toolbarButtonPressed : null,
                !editable ? styles.toolbarButtonDisabled : null
              ]}
            >
              <Icon size={15} color={editable ? colors.textPrimary : colors.textMuted} />
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
})

const styles = themedStyleSheet(() => ({
  toolbar: {
    minHeight: 42,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  toolbarContent: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6
  },
  toolbarButton: {
    minWidth: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    paddingHorizontal: spacing.xs
  },
  toolbarButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  toolbarButtonDisabled: {
    opacity: 0.55
  }
}))
