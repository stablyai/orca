import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronDown, Keyboard as KeyboardIcon, RefreshCw } from 'lucide-react-native'
import {
  MobileRichMarkdownEditor,
  type MobileRichMarkdownEditorHandle
} from '../components/MobileRichMarkdownEditor'
import { colors, spacing } from '../theme/mobile-theme'
import {
  resolveMarkdownFloatingActionsBottom,
  shouldShowMarkdownFloatingActions
} from './markdown-floating-actions-layout'
import type { MarkdownDocState } from './mobile-session-route-types'
import { styles } from './mobile-session-styles'

type Props = {
  documentId: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDiscard: () => void
  keyboardLift: number
}

export function MobileMarkdownReader({
  documentId,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onDiscard,
  keyboardLift
}: Props) {
  const editorRef = useRef<MobileRichMarkdownEditorHandle>(null)
  // Native Keyboard events under-report the WebView editor's covered area, so prefer the larger WebView-measured inset.
  const [webviewKeyboardInset, setWebviewKeyboardInset] = useState(0)
  const effectiveKeyboardLift = Math.max(keyboardLift, webviewKeyboardInset)
  const keyboardOpen = effectiveKeyboardLift > 0

  if (!doc || doc.status === 'loading') {
    return (
      <View style={styles.markdownState}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (doc.status === 'error') {
    return (
      <View style={styles.markdownState}>
        <Text style={styles.markdownError}>{doc.message}</Text>
        <Pressable style={styles.markdownRefreshButton} onPress={onRefresh}>
          <RefreshCw size={14} color={colors.textPrimary} />
          <Text style={styles.markdownRefreshText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  const statusText = doc.saveError
    ? doc.saveError
    : doc.readOnlyReason
      ? 'Read only'
      : doc.stale
        ? 'Changed on desktop'
        : null
  const showRefresh = Boolean((doc.stale && !doc.isDirty) || !doc.editable)
  const showCopy = Boolean(doc.saveError || !doc.editable)
  const showSave = Boolean(doc.isDirty || doc.saving)
  const showFloatingActions = shouldShowMarkdownFloatingActions({
    keyboardLift: effectiveKeyboardLift,
    hasStatus: statusText != null,
    showRefresh,
    showCopy,
    showSave
  })

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
        ref={editorRef}
        key={documentId}
        content={doc.localContent}
        editable={doc.editable && !doc.saving}
        onChange={onChange}
        onKeyboardInsetChange={setWebviewKeyboardInset}
      />
      {showFloatingActions ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.markdownFloatingBar,
            // Why: editor focus lives in a WebView, so lift native Save/Discard controls instead of resizing it.
            {
              bottom: resolveMarkdownFloatingActionsBottom({
                keyboardLift: effectiveKeyboardLift,
                restingBottom: spacing.lg,
                liftedClearance: spacing.md
              })
            }
          ]}
        >
          {statusText ? (
            <Text
              style={[styles.markdownFloatingStatus, doc.saveError ? styles.markdownError : null]}
              numberOfLines={2}
            >
              {statusText}
            </Text>
          ) : null}
          <View style={styles.markdownFloatingActions}>
            {keyboardOpen ? (
              <Pressable
                style={[styles.markdownFloatingButton, styles.markdownKeyboardDismissButton]}
                onPress={() => editorRef.current?.dismissKeyboard()}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Dismiss keyboard"
                accessibilityHint="Hides the software keyboard and keeps the markdown editor open."
              >
                <View style={styles.keyboardDismissGlyph}>
                  <KeyboardIcon size={15} color={colors.textSecondary} strokeWidth={2} />
                  <ChevronDown
                    size={10}
                    color={colors.textSecondary}
                    strokeWidth={2.5}
                    style={styles.keyboardDismissChevron}
                  />
                </View>
              </Pressable>
            ) : null}
            {showCopy ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onCopy}>
                <Text style={styles.markdownFloatingButtonText}>Copy</Text>
              </Pressable>
            ) : null}
            {showRefresh ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onRefresh}>
                <RefreshCw size={13} color={colors.textPrimary} />
                <Text style={styles.markdownFloatingButtonText}>Refresh</Text>
              </Pressable>
            ) : null}
            {doc.isDirty ? (
              <Pressable style={styles.markdownFloatingButton} onPress={onDiscard}>
                <Text style={styles.markdownFloatingButtonText}>Discard</Text>
              </Pressable>
            ) : null}
            {showSave ? (
              <Pressable
                style={[
                  styles.markdownFloatingButton,
                  styles.markdownSaveButton,
                  (!doc.editable || !doc.isDirty || doc.saving) && styles.markdownButtonDisabled
                ]}
                disabled={!doc.editable || !doc.isDirty || doc.saving}
                onPress={onSave}
              >
                {doc.saving ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Text style={styles.markdownFloatingButtonText}>Save</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  )
}
