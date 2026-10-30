import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { MobileRichMarkdownEditor } from '../components/MobileRichMarkdownEditor'
import { MobileFileAddressToolbar } from '../components/MobileFileAddressToolbar'
import { MobileFilePreviewSourceText } from '../files/MobileFilePreviewSourceText'
import { useMobileLineNumbersPreference } from '../files/mobile-line-numbers-preference'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'
import {
  getMobileMarkdownScrollRatio,
  saveMobileMarkdownScrollRatio,
  useMobileMarkdownViewMode
} from './mobile-markdown-view-mode-state'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MarkdownDocState } from './mobile-session-route-types'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

export function MarkdownReader({
  documentId,
  doc,
  title,
  relativePath,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onCopyPath,
  onDiscard,
  keyboardLift
}: {
  documentId: string
  doc: MarkdownDocState | undefined
  title?: string
  relativePath?: string
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: () => void
  onCopyPath: () => void
  onDiscard: () => void
  keyboardLift: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Native Keyboard events under-report the WebView editor's covered area, so prefer the larger WebView-measured inset.
  const [webviewKeyboardInset, setWebviewKeyboardInset] = useState(0)
  const documentKey = relativePath || title || documentId
  const [viewMode, setViewMode] = useMobileMarkdownViewMode(documentKey)
  const [showLineNumbers, setShowLineNumbers] = useMobileLineNumbersPreference()
  const effectiveKeyboardLift = Math.max(keyboardLift, webviewKeyboardInset)

  const scrollRatioRef = useRef(getMobileMarkdownScrollRatio(documentKey))

  useEffect(() => {
    scrollRatioRef.current = getMobileMarkdownScrollRatio(documentKey)
  }, [documentKey])

  const handleScrollRatioChange = useCallback(
    (ratio: number) => {
      scrollRatioRef.current = ratio
      saveMobileMarkdownScrollRatio(documentKey, ratio)
    },
    [documentKey]
  )

  if (!doc || doc.status === 'loading') {
    return (
      <View style={styles.markdownState}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (doc.status === 'error') {
    return <MobileLoadErrorState message={doc.message} onRetry={onRefresh} />
  }

  const statusText = markdownReaderStatusText(doc)
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showSave = doc.isDirty || doc.saving

  return (
    <View style={styles.markdownEditor}>
      {viewMode === 'editor' ? (
        <MobileRichMarkdownEditor
          key={`${documentId}-${viewMode}`}
          content={doc.localContent}
          editable={doc.editable && !doc.saving}
          onChange={onChange}
          onKeyboardInsetChange={setWebviewKeyboardInset}
          initialScrollRatio={scrollRatioRef.current}
          onScrollRatioChange={handleScrollRatioChange}
        />
      ) : (
        <>
          <MobileFileAddressToolbar
            path={relativePath || title || 'Markdown'}
            showLineNumbers={showLineNumbers}
            onToggleLineNumbers={() => setShowLineNumbers((prev) => !prev)}
            content={doc.localContent}
            truncated={doc.truncated}
            copyAccessibilityLabel="Copy file content"
          />
          <MobileFilePreviewSourceText
            relativePath={relativePath || title || 'markdown.md'}
            content={doc.localContent}
            truncated={doc.truncated}
            byteLength={doc.byteLength}
            showLineNumbers={showLineNumbers}
            initialScrollRatio={scrollRatioRef.current}
            onScrollRatioChange={handleScrollRatioChange}
          />
        </>
      )}
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
          <Pressable
            style={[styles.markdownFloatingButton, styles.markdownCopyButton]}
            onPress={onCopy}
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
            style={[styles.markdownFloatingButton, styles.markdownCopyButton]}
            onPress={onCopyPath}
            accessibilityRole="button"
            accessibilityLabel={t('session.markdownReader.copyPathLabel', 'Copy Markdown path')}
          >
            <Text style={styles.markdownFloatingButtonText}>
              {t('session.markdownReader.copyPath', 'Copy path')}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.markdownFloatingButton,
              viewMode === 'source' && styles.markdownFloatingButtonActive
            ]}
            onPress={() => setViewMode((prev) => (prev === 'editor' ? 'source' : 'editor'))}
            accessibilityRole="button"
            accessibilityLabel={viewMode === 'editor' ? 'View Markdown source' : 'View rich editor'}
          >
            <Text style={styles.markdownFloatingButtonText}>
              {viewMode === 'editor' ? 'Source' : 'Rich Text'}
            </Text>
          </Pressable>
          {showRefresh ? (
            <Pressable style={styles.markdownFloatingButton} onPress={onRefresh}>
              <RefreshCw size={13} color={colors.textPrimary} />
              <Text style={styles.markdownFloatingButtonText}>
                {t('common.refresh', 'Refresh')}
              </Text>
            </Pressable>
          ) : null}
          {doc.isDirty ? (
            <Pressable style={styles.markdownFloatingButton} onPress={onDiscard}>
              <Text style={styles.markdownFloatingButtonText}>
                {t('session.markdownReader.discard', 'Discard')}
              </Text>
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
                <Text style={styles.markdownFloatingButtonText}>{t('common.save', 'Save')}</Text>
              )}
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  )
}
