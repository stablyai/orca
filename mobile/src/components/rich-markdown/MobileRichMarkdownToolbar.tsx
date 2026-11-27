import { memo, type ComponentType } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import {
  Bold,
  ChevronDown,
  Code2,
  FileCode2,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Keyboard,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Strikethrough
} from 'lucide-react-native'
import { feedback, radii, spacing } from '../../theme/mobile-theme'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useKeyboardPersistingTaps } from '../../platform/keyboard/keyboard-persisting-taps'
import type { MobileRichMarkdownCommand } from './mobile-rich-markdown-editor-contract'

type Icon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

type ToolbarItem = {
  command: MobileRichMarkdownCommand | 'heading'
  label: (t: Translate) => string
  icon: Icon
}

// The everyday styles first; the rest scroll in. Heading is one button that steps through the levels.
const TOOLBAR_ITEMS: ToolbarItem[] = [
  { command: 'bold', label: (t) => t('components.richMarkdownToolbar.bold', 'Bold'), icon: Bold },
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
    command: 'heading',
    label: (t) => t('components.richMarkdownToolbar.heading', 'Heading'),
    icon: Heading
  },
  {
    command: 'bulletList',
    label: (t) => t('components.richMarkdownToolbar.bulletList', 'Bullet list'),
    icon: List
  },
  {
    command: 'taskList',
    label: (t) => t('components.richMarkdownToolbar.checklist', 'Checklist'),
    icon: ListTodo
  },
  {
    command: 'inlineCode',
    label: (t) => t('components.richMarkdownToolbar.inlineCode', 'Inline code'),
    icon: Code2
  },
  { command: 'link', label: (t) => t('components.richMarkdownToolbar.link', 'Link'), icon: Link },
  {
    command: 'orderedList',
    label: (t) => t('components.richMarkdownToolbar.numberedList', 'Numbered list'),
    icon: ListOrdered
  },
  {
    command: 'quote',
    label: (t) => t('components.richMarkdownToolbar.quote', 'Quote'),
    icon: Quote
  },
  {
    command: 'codeBlock',
    label: (t) => t('components.richMarkdownToolbar.codeBlock', 'Code block'),
    icon: FileCode2
  },
  {
    command: 'image',
    label: (t) => t('components.richMarkdownToolbar.image', 'Image'),
    icon: ImageIcon
  }
]

const HEADING_LEVELS: { command: MobileRichMarkdownCommand; icon: Icon }[] = [
  { command: 'heading1', icon: Heading1 },
  { command: 'heading2', icon: Heading2 },
  { command: 'heading3', icon: Heading3 }
]

/** H1 -> H2 -> H3 -> body, starting at H1 outside a heading; the icon names the current level. */
function headingStep(active: readonly MobileRichMarkdownCommand[]) {
  const level = HEADING_LEVELS.findIndex((entry) => active.includes(entry.command))
  return {
    icon: level === -1 ? Heading : HEADING_LEVELS[level].icon,
    lit: level !== -1,
    next: level === -1 ? 'heading1' : (HEADING_LEVELS[level + 1]?.command ?? 'paragraph')
  } satisfies { icon: Icon; lit: boolean; next: MobileRichMarkdownCommand }
}

/** The format row that rides above the keyboard while the note is being edited. */
export const MobileRichMarkdownToolbar = memo(function MobileRichMarkdownToolbar({
  active,
  onCommand,
  onDismissKeyboard
}: {
  active: readonly MobileRichMarkdownCommand[]
  onCommand: (command: MobileRichMarkdownCommand) => void
  onDismissKeyboard: () => void
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  // A tap on a button must not take the caret, or the row would vanish under the finger.
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const heading = headingStep(active)
  return (
    <View ref={keepsKeyboard} style={styles.toolbar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="always"
      >
        {TOOLBAR_ITEMS.map((item) => {
          const { command } = item
          return (
            <ToolbarButton
              key={command}
              icon={command === 'heading' ? heading.icon : item.icon}
              label={item.label(t)}
              lit={command === 'heading' ? heading.lit : active.includes(command)}
              onPress={() => onCommand(command === 'heading' ? heading.next : command)}
            />
          )
        })}
      </ScrollView>
      <View style={styles.divider} />
      <ToolbarButton
        icon={DismissKeyboardGlyph}
        label={t('session.accessoryKeys.dismissKeyboard', 'Dismiss keyboard')}
        onPress={onDismissKeyboard}
      />
    </View>
  )
})

/** The terminal key row's dismiss key: a keyboard with a chevron under it. */
function DismissKeyboardGlyph({ color }: { color?: string }) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.dismissGlyph}>
      <Keyboard size={15} color={color} strokeWidth={2} />
      <ChevronDown size={10} color={color} strokeWidth={2.5} style={styles.dismissChevron} />
    </View>
  )
}

function ToolbarButton({
  icon: IconComponent,
  label,
  lit,
  onPress
}: {
  icon: Icon
  label: string
  lit?: boolean
  onPress: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-pressed={lit}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View style={[styles.mark, lit && styles.markLit]}>
        <IconComponent size={18} color={colors.textPrimary} strokeWidth={2} />
      </View>
    </Pressable>
  )
}

// The terminal key row's 46 pt bar with real 44 pt buttons, as the page ignores hitSlop.
const stylesSheet = themedStyleSheet((colors) => ({
  toolbar: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  scroll: { flex: 1, minWidth: 0 },
  scrollContent: { alignItems: 'center' },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    backgroundColor: colors.borderSubtle
  },
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { opacity: feedback.pressedOpacity },
  mark: {
    width: 40,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  markLit: { backgroundColor: colors.translucentFill },
  dismissGlyph: { width: 18, height: 18, alignItems: 'center' },
  dismissChevron: { position: 'absolute', bottom: -2 }
}))
