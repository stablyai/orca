import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { CircleHelp, X } from 'lucide-react-native'
import { nativeChatAsyncQuestionKeyedOptions } from '../../../src/shared/native-chat-async-question-answers'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { mobileNativeChatInputStyles } from './mobile-native-chat-input-styles'
import type { MobileNativeChatAsyncQuestionsModel } from './use-mobile-native-chat-async-questions'

/** Codex's non-blocking questions above the composer, which stays usable: suggested
 *  choices and a free-text answer per question, a per-question Dismiss (this device
 *  only), and one Send that posts the answers as an ordinary message. */
export function MobileNativeChatAsyncQuestions({
  model
}: {
  model: MobileNativeChatAsyncQuestionsModel
}): React.JSX.Element | null {
  const { open, omittedCount, edits, held, sending, canSend } = model
  if (open.length === 0) {
    return null
  }
  return (
    <View testID="native-chat-async-questions-card" style={styles.card}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
        {open.map((question) => {
          const answer = edits[question.key]
          // A held question shows the answer on its way; Dismiss stays usable.
          const locked = sending || held.has(question.key)
          return (
            <View key={question.key} style={styles.question}>
              <View style={styles.header}>
                <CircleHelp size={16} color={colors.accentBlue} strokeWidth={2} />
                <Text style={styles.title}>{question.title}</Text>
                <Pressable
                  accessibilityLabel="Dismiss"
                  hitSlop={8}
                  style={styles.dismiss}
                  disabled={sending}
                  onPress={() => model.dismiss(question.key)}
                >
                  <X size={16} color={colors.textMuted} strokeWidth={2} />
                </Pressable>
              </View>
              {question.options && question.options.length > 0 ? (
                <View style={styles.options}>
                  {nativeChatAsyncQuestionKeyedOptions(question.options).map(({ key, option }) => {
                    const selected = answer?.option === option
                    return (
                      <Pressable
                        key={key}
                        accessibilityState={{ selected }}
                        disabled={locked}
                        style={({ pressed }) => [
                          styles.option,
                          selected && styles.optionSelected,
                          pressed && styles.pressed
                        ]}
                        onPress={() =>
                          model.edit(question.key, {
                            ...answer,
                            option: selected ? undefined : option
                          })
                        }
                      >
                        <Text style={styles.optionText}>{option}</Text>
                      </Pressable>
                    )
                  })}
                </View>
              ) : null}
              <TextInput
                style={mobileNativeChatInputStyles.freeInput}
                value={answer?.text ?? ''}
                editable={!locked}
                onChangeText={(text) => model.edit(question.key, { ...answer, text })}
                placeholder="Type your reply…"
                placeholderTextColor={colors.textMuted}
                selectionColor={colors.accentBlue}
                multiline
              />
            </View>
          )
        })}
      </ScrollView>
      <View style={styles.footer}>
        {omittedCount > 0 ? (
          <Text style={styles.more}>
            {`${omittedCount} more ${omittedCount === 1 ? 'question' : 'questions'} in the transcript`}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel="Send answers"
          disabled={!canSend}
          style={({ pressed }) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && styles.pressed
          ]}
          onPress={model.submit}
        >
          <Text style={styles.sendText}>{sending ? 'Sending…' : 'Send'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    flexShrink: 1,
    minHeight: 0
  },
  scroll: { maxHeight: 280, flexShrink: 1, minHeight: 0 },
  list: { gap: spacing.md },
  question: { gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  dismiss: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  optionSelected: { borderColor: colors.accentBlue },
  optionText: { color: colors.textPrimary, fontSize: typography.bodySize },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  more: { flex: 1, color: colors.textMuted, fontSize: typography.metaSize },
  send: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    backgroundColor: colors.accentBlue
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: colors.onAccent, fontSize: typography.bodySize, fontWeight: '600' },
  pressed: { opacity: 0.7 }
})
