import { useState } from 'react'
import { StyleSheet, View, Text } from 'react-native'
import { Copy, RefreshCw } from 'lucide-react-native'
import { Button } from '../components/ui/Button'
import { StateView } from '../components/ui/StateView'
import { MobileRichMarkdownEditor } from '../components/MobileRichMarkdownEditor'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { MarkdownDocState } from './mobile-session-route-types'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

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
    return <StateView loading title="Loading note…" />
  }
  if (doc.status === 'error') {
    return <MobileLoadErrorState message={doc.message} onRetry={onRefresh} />
  }

  const statusText = markdownReaderStatusText(doc)
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showSave = doc.isDirty || doc.saving

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
        key={documentId}
        content={doc.localContent}
        editable={doc.editable && !doc.saving}
        onChange={onChange}
        onKeyboardInsetChange={setWebviewKeyboardInset}
      />
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
            style={[localStyles.status, doc.saveError ? localStyles.statusError : null]}
            numberOfLines={2}
          >
            {statusText}
          </Text>
        ) : null}
        {/* Opaque, so the buttons read over the note's text. */}
        <View style={localStyles.actions}>
          <Button
            label={doc.truncated ? 'Copy loaded' : 'Copy'}
            icon={Copy}
            size="compact"
            variant="plain"
            onPress={onCopy}
            accessibilityLabel={
              doc.truncated ? 'Copy loaded Markdown source' : 'Copy Markdown source'
            }
          />
          {showRefresh ? (
            <Button
              label="Refresh"
              icon={RefreshCw}
              size="compact"
              variant="plain"
              onPress={onRefresh}
            />
          ) : null}
          {doc.isDirty ? (
            <Button label="Discard" size="compact" variant="plain" onPress={onDiscard} />
          ) : null}
          {showSave ? (
            <Button
              label="Save"
              size="compact"
              variant="primary"
              busy={doc.saving}
              disabled={!doc.editable || !doc.isDirty}
              onPress={onSave}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
}

const localStyles = StyleSheet.create({
  status: {
    ...textStyles.footnote,
    maxWidth: '100%',
    alignSelf: 'flex-end',
    overflow: 'hidden',
    color: colors.textSecondary,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder,
    borderRadius: radii.group,
    paddingHorizontal: spacing.md,
    paddingVertical: 6
  },
  statusError: { color: colors.danger },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder
  }
})
