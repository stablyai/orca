import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { MobileRichMarkdownEditor } from '../../components/MobileRichMarkdownEditor'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'
import { colors, spacing, pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { styles } from '../../session/mobile-session-styles'
import type { MarkdownDocState } from './session-document-state'
import { MobileLoadErrorState, MobileStateView } from '../../components/MobileStateView'
import { useDocumentEditDraft } from '../../drafts/use-document-edit-draft'
import { DocumentEditDraftOfferBar } from '../../drafts/DocumentEditDraftOfferBar'

export function MarkdownReader({
  documentId,
  draftKey,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onCopyPath,
  onDiscard,
  loadImageSource,
  keyboardLift
}: {
  documentId: string
  draftKey: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: (text: string) => void
  onCopyPath: () => void
  onDiscard: () => void
  loadImageSource?: (path: string) => Promise<string>
  keyboardLift: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Native Keyboard events under-report the WebView editor's covered area, so prefer the larger WebView-measured inset.
  const [webviewKeyboardInset, setWebviewKeyboardInset] = useState(0)
  const effectiveKeyboardLift = Math.max(keyboardLift, webviewKeyboardInset)
  const ready = doc?.status === 'ready' ? doc : null
  const editDraft = useDocumentEditDraft({
    draftKey,
    base: ready?.content ?? null,
    editable: ready?.editable === true,
    live: ready?.localContent ?? '',
    onRestore: onChange
  })
  if (!doc || doc.status === 'loading') {
    return (
      <MobileStateView loading title={t('session.markdownReader.loading', 'Loading document…')} />
    )
  }
  if (doc.status === 'error') {
    return <MobileLoadErrorState error={doc.message} onRetry={onRefresh} />
  }

  const statusText = markdownReaderStatusText(doc)
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showSave = doc.isDirty || doc.saving
  // Why: editor focus lives in a WebView, so lift native Save/Discard controls instead of resizing it.
  const floatingBottom = resolveMarkdownFloatingActionsBottom({
    keyboardLift: effectiveKeyboardLift,
    restingBottom: spacing.lg,
    liftedClearance: spacing.md
  })

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
        key={documentId}
        content={doc.localContent}
        editable={doc.editable && !doc.saving}
        onChange={onChange}
        onKeyboardInsetChange={setWebviewKeyboardInset}
        loadImageSource={loadImageSource}
      />
      {editDraft.offer ? (
        <DocumentEditDraftOfferBar
          offer={editDraft.offer}
          bottom={floatingBottom}
          onDiscard={editDraft.discardOffer}
          onRestore={editDraft.restore}
          onCopy={() => onCopy(editDraft.offer?.content ?? '')}
        />
      ) : (
        <View
          pointerEvents="box-none"
          style={[
            styles.markdownFloatingBar,
            // Why: editor focus lives in a WebView, so lift native Save/Discard controls instead of resizing it.
            { bottom: floatingBottom }
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
            <Pressable
              style={({ pressed }) => [
                styles.markdownFloatingButton,
                styles.markdownCopyButton,
                pressed && pressedStyle
              ]}
              onPress={() => onCopy(doc.localContent)}
              accessibilityRole="button"
              accessibilityLabel={
                doc.truncated
                  ? t('session.markdownReader.copyLoadedSource', 'Copy loaded Markdown source')
                  : t('session.markdownReader.copySource', 'Copy Markdown source')
              }
            >
              <Text style={styles.markdownFloatingButtonText}>
                {doc.truncated
                  ? t('session.markdownReader.copyLoaded', 'Copy loaded')
                  : t('common.copy', 'Copy')}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.markdownFloatingButton,
                styles.markdownCopyButton,
                pressed && pressedStyle
              ]}
              onPress={onCopyPath}
              accessibilityRole="button"
              accessibilityLabel={t('session.markdownReader.copyPathLabel', 'Copy Markdown path')}
            >
              <Text style={styles.markdownFloatingButtonText}>
                {t('session.markdownReader.copyPath', 'Copy path')}
              </Text>
            </Pressable>
            {showRefresh ? (
              <Pressable
                style={({ pressed }) => [styles.markdownFloatingButton, pressed && pressedStyle]}
                onPress={onRefresh}
              >
                <RefreshCw size={13} color={colors.textPrimary} />
                <Text style={styles.markdownFloatingButtonText}>
                  {t('common.refresh', 'Refresh')}
                </Text>
              </Pressable>
            ) : null}
            {doc.isDirty ? (
              <Pressable
                style={({ pressed }) => [styles.markdownFloatingButton, pressed && pressedStyle]}
                onPress={onDiscard}
              >
                <Text style={styles.markdownFloatingButtonText}>
                  {t('session.markdownReader.discard', 'Discard')}
                </Text>
              </Pressable>
            ) : null}
            {showSave ? (
              <Pressable
                style={({ pressed }) => [
                  styles.markdownFloatingButton,
                  styles.markdownSaveButton,
                  (!doc.editable || !doc.isDirty || doc.saving) && styles.markdownButtonDisabled,
                  pressed && pressedStyle
                ]}
                disabled={!doc.editable || !doc.isDirty || doc.saving}
                onPress={onSave}
              >
                {doc.saving ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Text style={styles.markdownFloatingButtonText}>{t('common.save', 'Save')}</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
      )}
    </View>
  )
}
