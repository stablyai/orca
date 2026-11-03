import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronLeft, Copy, ExternalLink, MoreHorizontal } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { colors, pressedStyle, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { translate } from '../i18n/mobile-i18n'
import { useClipboardWriter } from '../platform/clipboard'
import { openExternalLink } from '../platform/external-link'
import { triggerSuccess } from '../platform/haptics'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import { statusColor } from './mobile-git-status'
import { gitCommitCompareRead, gitRemoteCommitUrlRead } from './mobile-git-read-operations'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import type { MobileGitHistoryItem } from './git-history-reply-schema'
import { buildMobileCommitDetail } from './mobile-git-history'
import { CommitLineStat } from './MobileCommitListRows'

// A failed refresh keeps the files already shown and adds its error.
type FilesState = { files: MobileGitChangedFile[] | null; error: string | null }

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  commit: MobileGitHistoryItem
  bottomInset: number
  onBack: () => void
  // Opens a file in the shared diff screen; rows stay inert when the host offers none.
  onOpenFile?: (filePath: string) => void
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

function isGitHubUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'github.com'
  } catch {
    return false
  }
}

export function MobileCommitDetailPage({
  client,
  connState,
  worktreeId,
  commit,
  bottomInset,
  onBack,
  onOpenFile
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const moreRef = useRef<View>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [files, setFiles] = useState<FilesState>({ files: null, error: null })
  const [filesReload, setFilesReload] = useState(0)
  const [webUrl, setWebUrl] = useState<string | null>(null)
  const detail = useMemo(() => buildMobileCommitDetail(commit), [commit, t])
  const connected = client !== null && connState === 'connected'

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    setFiles((prev) => ({ files: prev.files, error: null }))
    void gitCommitCompareRead
      .request(client, { worktree: `id:${worktreeId}`, commitId: commit.id })
      .then((reply) => {
        const compared = gitCommitCompareRead.interpret(reply)
        if (!stale) {
          setFiles({ files: compared.entries, error: null })
        }
      })
      .catch((err) => {
        if (!stale) {
          setFiles((prev) => ({
            files: prev.files,
            error:
              err instanceof Error
                ? err.message
                : translate(
                    'sourceControl.gitHistoryList.loadFilesFailed',
                    'Unable to load commit files'
                  )
          }))
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState, commit.id, filesReload, worktreeId])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    void gitRemoteCommitUrlRead
      .request(client, { worktree: `id:${worktreeId}`, sha: commit.id })
      .then((reply) => {
        const url = gitRemoteCommitUrlRead.interpret(reply)
        if (!stale) {
          setWebUrl(url)
        }
      })
      // No remote, a provider without commit pages, or an older host: the item stays hidden.
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [client, connState, commit.id, worktreeId])

  const actions: ActionSheetAction[] = [
    {
      id: 'copy-sha',
      label: t('sourceControl.commitDetail.copySha', 'Copy SHA'),
      icon: Copy,
      onPress: () => {
        void clipboard.writeText(commit.id).then(triggerSuccess, () => {})
      }
    },
    ...(webUrl
      ? [
          {
            id: 'open-web',
            label: isGitHubUrl(webUrl)
              ? t('sourceControl.commitDetail.openOnGitHub', 'Open on GitHub')
              : t('sourceControl.commitDetail.openOnWeb', 'Open on the web'),
            icon: ExternalLink,
            closeBeforePress: true,
            onPress: () => openExternalLink(webUrl)
          }
        ]
      : [])
  ]

  const loadedFiles = files.files
  const totals = loadedFiles
    ? loadedFiles.reduce(
        (sum, file) => ({
          added: sum.added + (file.added ?? 0),
          removed: sum.removed + (file.removed ?? 0)
        }),
        { added: 0, removed: 0 }
      )
    : null
  const shortId = commit.displayId ?? commit.id.slice(0, 7)

  return (
    <View style={styles.page}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={onBack}
            accessibilityLabel={t('sourceControl.commitDetail.back', 'Back to commits')}
          />
        }
        title={t('sourceControl.commitDetail.title', 'Commit')}
        subtitle={shortId}
        trailing={
          <NavBarButton
            ref={moreRef}
            icon={MoreHorizontal}
            active={menuOpen}
            onPress={() => setMenuOpen(true)}
            accessibilityLabel={t('sourceControl.commitDetail.more', 'More commit actions')}
          />
        }
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={[actions]}
        onClose={() => setMenuOpen(false)}
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: spacing.lg + bottomInset }]}
      >
        <Text style={styles.subject} selectable>
          {detail.subject}
        </Text>
        {detail.body ? (
          <Text style={styles.body} selectable>
            {detail.body}
          </Text>
        ) : null}
        <ListGroup style={styles.facts}>
          <ListRow
            key="author"
            title={t('sourceControl.commitDetail.author', 'Author')}
            value={detail.author}
          />
          {detail.date ? (
            <ListRow
              key="date"
              title={t('sourceControl.commitDetail.date', 'Date')}
              value={detail.date}
            />
          ) : null}
          {commit.pushed !== undefined ? (
            <ListRow
              key="status"
              title={t('sourceControl.commitDetail.status', 'Status')}
              accessory={
                <Text style={commit.pushed ? styles.statusPushed : styles.statusUnpushed}>
                  {commit.pushed
                    ? t('sourceControl.commitDetail.onOrigin', 'On origin')
                    : t('sourceControl.commitDetail.notPushed', 'Not pushed')}
                </Text>
              }
            />
          ) : null}
        </ListGroup>
        <SectionHeader
          title={
            loadedFiles
              ? loadedFiles.length === 1
                ? t('sourceControl.commitDetail.files_one', '{{count}} file', { count: 1 })
                : t('sourceControl.commitDetail.files_other', '{{count}} files', {
                    count: loadedFiles.length
                  })
              : t('sourceControl.commitDetail.filesHeader', 'Files')
          }
          trailing={
            totals ? <CommitLineStat added={totals.added} removed={totals.removed} /> : undefined
          }
        />
        {/* A transport drop can carry an empty message; it is still a failure, so test for null. */}
        {files.error !== null ? (
          <View style={styles.errorBlock}>
            <Text style={styles.errorText}>{files.error}</Text>
            {connected ? (
              <Pressable
                style={({ pressed }) => [styles.retryButton, pressed && pressedStyle]}
                accessibilityRole="button"
                accessibilityLabel={t(
                  'sourceControl.gitHistoryList.retryFiles',
                  'Retry commit files'
                )}
                onPress={() => setFilesReload((value) => value + 1)}
              >
                <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {loadedFiles === null ? (
          files.error !== null ? null : connected ? (
            <ActivityIndicator style={styles.loading} size="small" color={colors.textSecondary} />
          ) : (
            <Text style={styles.note}>
              {t('sourceControl.gitHistoryList.waitingForDesktop', 'Waiting for desktop...')}
            </Text>
          )
        ) : loadedFiles.length === 0 ? (
          <Text style={styles.note}>
            {t('sourceControl.gitHistoryList.noFileChanges', 'No file changes')}
          </Text>
        ) : (
          loadedFiles.map((file) => (
            <CommitFileRow key={file.path} file={file} onOpen={onOpenFile} />
          ))
        )}
      </ScrollView>
    </View>
  )
}

function CommitFileRow({
  file,
  onOpen
}: {
  file: MobileGitChangedFile
  onOpen?: (filePath: string) => void
}) {
  useMobileColorScheme()
  const status = file.status ?? 'modified'
  const { name, dir } = splitPath(file.path)
  return (
    <Pressable
      style={({ pressed }) => [styles.fileRow, pressed && onOpen && styles.fileRowPressed]}
      disabled={!onOpen}
      onPress={() => onOpen?.(file.path)}
      accessibilityRole={onOpen ? 'button' : undefined}
      accessibilityLabel={file.path}
    >
      <Text style={[styles.fileStatus, { color: statusColor(status) }]}>
        {STATUS_LABELS[status]}
      </Text>
      <View style={styles.fileMain}>
        <Text
          style={[styles.fileName, status === 'deleted' && styles.fileNameDeleted]}
          numberOfLines={1}
        >
          {name}
        </Text>
        {dir ? (
          <Text style={styles.fileDir} numberOfLines={1}>
            {dir}
          </Text>
        ) : null}
      </View>
      <CommitLineStat added={file.added ?? 0} removed={file.removed ?? 0} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.bgBase },
  content: {},
  subject: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg
  },
  body: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  facts: { marginTop: spacing.md, marginHorizontal: spacing.lg },
  statusPushed: { color: colors.textSecondary, fontSize: typography.bodySize },
  statusUnpushed: { color: colors.accentBlue, fontSize: typography.bodySize, fontWeight: '500' },
  loading: { paddingVertical: spacing.lg },
  note: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  errorText: { color: colors.textMuted, fontSize: typography.metaSize },
  errorBlock: { alignItems: 'flex-start', paddingHorizontal: spacing.lg },
  retryButton: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  retryText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  fileStatus: {
    width: 12,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    fontWeight: '600'
  },
  fileRowPressed: { backgroundColor: colors.bgRaised },
  fileMain: { flex: 1, minWidth: 0 },
  fileName: { color: colors.textPrimary, fontSize: typography.bodySize },
  fileNameDeleted: { textDecorationLine: 'line-through', color: colors.textMuted },
  fileDir: { color: colors.textMuted, fontSize: typography.metaSize, marginTop: 2 }
}))
