import { useState } from 'react'
import { MobileFileMarkdownPreview } from '../files/MobileFileMarkdownPreview'
import type { MobileFilePreviewRpcSender } from '../files/mobile-file-preview-operations'
import { mobileMarkdownFileLink } from '../files/mobile-markdown-file-link'
import { routeMarkdownHref } from '../components/markdown-href-routing'
import { openExternalLink } from '../platform/external-link'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { MobileRichMarkdownEditor } from '../components/MobileRichMarkdownEditor'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MarkdownDocState } from './mobile-session-route-types'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

export function MarkdownReader({
  documentId,
  hostId,
  worktreeId,
  relativePath,
  filePath,
  client,
  onLinkError,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onCopyPath,
  onDiscard,
  keyboardLift
}: {
  documentId: string
  hostId?: string
  worktreeId?: string
  relativePath?: string
  filePath?: string
  client?: MobileFilePreviewRpcSender | null
  onLinkError?: (message: string) => void
  doc: MarkdownDocState | undefined
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
  const router = useWorkspaceRouteHandoff()
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null)
  const editing = editingDocumentId === documentId
  const openFile = (pathText: string) => {
    const href =
      hostId && worktreeId && relativePath
        ? mobileMarkdownFileLink({ hostId, worktreeId, relativePath }, pathText, filePath)
        : null
    if (href) {
      router.push(href)
    } else {
      onLinkError?.(
        t(
          'session.markdownReader.fileUnavailable',
          'This file is outside the current workspace or is unavailable.'
        )
      )
    }
  }
  const openLink = (href: string) => {
    const route = routeMarkdownHref(href)
    if (route.kind === 'file') {
      openFile(route.pathText)
    } else if (route.kind === 'web') {
      openExternalLink(route.url)
    }
  }
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
    return <MobileLoadErrorState message={doc.message} onRetry={onRefresh} />
  }

  const statusText = markdownReaderStatusText(doc)
  const showRefresh = (doc.stale && !doc.isDirty) || !doc.editable
  const showSave = doc.isDirty || doc.saving
  // Leaving the editor stays possible even when the document turns read-only mid-edit.
  const editToggleDisabled = !editing && (!doc.editable || doc.saving)

  return (
    <View style={styles.markdownEditor}>
      {editing ? (
        <MobileRichMarkdownEditor
          key={documentId}
          content={doc.localContent}
          editable={doc.editable && !doc.saving}
          onChange={onChange}
          onOpenLink={openLink}
          onKeyboardInsetChange={setWebviewKeyboardInset}
        />
      ) : (
        <MobileFileMarkdownPreview
          key={documentId}
          relativePath={relativePath ?? documentId}
          documentAbsolutePath={filePath}
          content={doc.localContent}
          truncated={doc.truncated ?? false}
          byteLength={doc.byteLength ?? 0}
          client={client}
          worktreeId={worktreeId}
          onOpenFile={openFile}
        />
      )}
      <View
        pointerEvents="box-none"
        style={[
          editing ? styles.markdownFloatingBar : styles.markdownReaderFooter,
          // Why: editor focus lives in a WebView, so lift native Save/Discard controls instead of resizing it.
          editing && {
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
            style={[
              styles.markdownFloatingButton,
              styles.markdownCopyButton,
              editToggleDisabled && styles.markdownButtonDisabled
            ]}
            accessibilityRole="button"
            accessibilityLabel={
              editing
                ? t('session.markdownReader.previewLabel', 'Preview Markdown')
                : t('session.markdownReader.editLabel', 'Edit Markdown')
            }
            disabled={editToggleDisabled}
            onPress={() => setEditingDocumentId(editing ? null : documentId)}
          >
            <Text style={styles.markdownFloatingButtonText}>
              {editing ? t('session.markdownReader.preview', 'Preview') : t('common.edit', 'Edit')}
            </Text>
          </Pressable>
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
