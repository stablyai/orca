import { useMemo } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { AskQuestion } from '../../../../../src/shared/native-chat/input/questions/native-chat-ask-types'
import { KeyedBottomDrawer } from '../../../components/bottom-drawer/keyed-bottom-drawer'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../../components/SheetPrimaryButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

const sheetKey = () => 'option-preview'

export function MobileNativeChatOptionPreviewSheet({
  options,
  viewedIndex,
  selected,
  disabled,
  onView,
  onChoose,
  onClose
}: {
  options: AskQuestion['options']
  viewedIndex: number | null
  selected: readonly number[]
  disabled: boolean
  onView: (index: number) => void
  onChoose: (index: number) => void
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const previews = useMemo(
    () => options.flatMap((option, index) => (option.preview ? [{ option, index }] : [])),
    [options]
  )
  return (
    <KeyedBottomDrawer
      sheet={viewedIndex}
      sheetKey={sheetKey}
      onClose={onClose}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      {(index) => {
        const option = options[index]!
        return (
          <>
            <SheetHeader
              title={option.label}
              subtitle={t('chat.ask.previewPosition', '{{current}} of {{total}}', {
                current: previews.findIndex((item) => item.index === index) + 1,
                total: previews.length
              })}
              onClose={onClose}
            />
            <ReadablePreview
              // oxlint-disable-next-line react-doctor/no-array-index-as-key -- Option indices are immutable answer identities; changing pages resets both scroll axes.
              key={index}
              preview={option.preview ?? ''}
            />
            {previews.length > 1 ? (
              <ScrollView
                horizontal
                style={styles.pages}
                contentContainerStyle={styles.pageContent}
              >
                {previews.map((item) => (
                  <Pressable
                    key={item.index}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.ask.optionPreview', '{{option}} preview', {
                      option: item.option.label
                    })}
                    accessibilityState={{ selected: item.index === index }}
                    onPress={() => onView(item.index)}
                    style={({ pressed }) => [styles.page, pressed && pressedStyle]}
                  >
                    <View style={[styles.dot, item.index === index && styles.currentDot]} />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <SheetPrimaryButton
              label={
                selected.includes(index)
                  ? t('chat.ask.chosen', 'Chosen')
                  : t('chat.ask.chooseThis', 'Choose this')
              }
              disabled={disabled}
              onPress={() => onChoose(index)}
            />
          </>
        )
      }}
    </KeyedBottomDrawer>
  )
}

function ReadablePreview({ preview }: { preview: string }): React.JSX.Element {
  useMobileColorScheme()
  return (
    <ScrollView style={styles.preview} showsVerticalScrollIndicator nestedScrollEnabled>
      <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
        <Text selectable style={styles.text}>
          {preview}
        </Text>
      </ScrollView>
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  preview: { flex: 1, minHeight: 0, backgroundColor: colors.bgPanel },
  text: {
    padding: spacing.md,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.bodySize,
    lineHeight: typography.bodySize * 1.5
  },
  pages: { flexGrow: 0, marginVertical: spacing.xs },
  pageContent: { flexGrow: 1, justifyContent: 'center' },
  page: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: colors.borderSubtle },
  currentDot: { backgroundColor: colors.textPrimary }
}))
