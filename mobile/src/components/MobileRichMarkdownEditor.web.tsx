import { forwardRef, memo, useImperativeHandle, useRef, type ForwardedRef } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
// The native component's own props and handle, so a change to either fails here rather than
// drifting.
import type {
  MobileRichMarkdownEditorComponentProps,
  MobileRichMarkdownEditorHandle
} from './MobileRichMarkdownEditor'

/**
 * Web sibling: the Markdown source in a plain field, which is the state the rich editor degrades
 * to when its document is unreachable.
 *
 * The native one is a ProseMirror document inside a `WebView`, and `react-native-webview` is a
 * native component with no browser counterpart — importing it runs a codegen lookup that throws,
 * and the route manifest imports every route, so one such import takes the whole page down rather
 * than one editor.
 *
 * A DOM editor is reachable and is deliberately not here (ruling 8): the toolbar's fifteen
 * commands are the rich document's, and reimplementing them against `contenteditable` is a
 * different surface with its own escaping and its own proof, not a smaller version of this one.
 * What the page keeps is the whole of what the screen around it needs — the text, every edit
 * reported through `onChange`, and Save, Discard, Copy and Refresh unchanged. What it loses is
 * the formatting toolbar and the rendered view, recorded as a degradation.
 *
 * `onKeyboardInsetChange` is never called, which is correct rather than missing: it exists because
 * native `Keyboard` events under-report a WebView's covered area, and here the screen's own
 * `keyboard-occlusion.web.ts` measurement is the only one there is.
 */
function MobileRichMarkdownEditorWebInner(
  { content, editable, onChange }: MobileRichMarkdownEditorComponentProps,
  ref: ForwardedRef<MobileRichMarkdownEditorHandle>
) {
  const inputRef = useRef<TextInput>(null)

  // Blur rather than `Keyboard.dismiss`: react-native-web's `Keyboard` is a stub, and the caret is
  // in this field rather than in a document that has to be told to give it up.
  useImperativeHandle(ref, () => ({ dismissKeyboard: () => inputRef.current?.blur() }), [])

  return (
    <View style={styles.container}>
      <View style={styles.notice}>
        <Text style={styles.noticeText}>markdown source</Text>
      </View>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={content}
        editable={editable}
        onChangeText={onChange}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Markdown source"
      />
    </View>
  )
}

export const MobileRichMarkdownEditor = memo(forwardRef(MobileRichMarkdownEditorWebInner))

// The native component's own frame, so the degradation sits where the editor sat rather than
// looking like a second design.
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase },
  notice: {
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  noticeText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  input: {
    flex: 1,
    minHeight: 0,
    padding: spacing.md,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    // The 16px seam: an input under it makes iOS zoom the page on focus and never zoom back, and
    // the keyboard seam reads that scale as "no keyboard" for the rest of the session.
    fontSize: TEXT_INPUT_FONT_SIZE
  }
})
