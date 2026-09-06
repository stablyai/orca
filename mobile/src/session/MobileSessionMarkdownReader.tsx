import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { MobileRichMarkdownEditor } from '../components/MobileRichMarkdownEditor'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'
import { colors, spacing } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MarkdownDocState } from './mobile-session-route-types'

export function MarkdownReader({
  documentId,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onDiscard,
  keyboardLift
}: {
  documentId: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onDiscard: () => void
  keyboardLift: number
}) {
  // Native Keyboard events under-report the WebView editor's covered area, so prefer the larger WebView-measured inset.
  const [webviewKeyboardInset, setWebviewKeyboardInset] = useState(0)
  const effectiveKeyboardLift = Math.max(keyboardLift, webviewKeyboardInset)
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
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showCopy = doc.saveError || !doc.editable
  const showSave = doc.isDirty || doc.saving
  const showFloatingActions = statusText || showRefresh || showCopy || showSave

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
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
