import { previewError, type MobileFilePreviewResult } from './preview/mobile-file-preview-response'
import { MobileChatAttachmentPreview } from './attachments/MobileChatAttachmentPreview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Pencil, Save } from 'lucide-react-native'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { getWorktreeLabel } from '../worktree/row-presentation/worktree-label'
import { useForceReconnect } from '../transport/connection/host-client-hooks'
import { useWorkspaceClient } from '../worktree/execution-hosts/use-workspace-client'
import { connectionRetryAction } from '../transport/connection/connection-retry-action'
import { loadMobileFilePreview } from './preview/mobile-file-preview-request'
import { MobileFilePreviewDiscardModal } from './preview/MobileFilePreviewDiscardModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileFilePreviewBody } from './preview/MobileFilePreviewBody'
import {
  MobileMarkdownPreviewModeBar,
  useMarkdownPreviewMode
} from './markdown/MobileMarkdownPreviewModeBar'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteState
} from './preview/mobile-file-preview-route'
import { previewSourceFromRoute, sourceKeyForPreview } from './preview/mobile-file-preview-source'
import { normalizeMobileFilePreviewLineColumn } from './preview/mobile-file-preview-line-column'
import {
  hasUnsavedMobileFilePreviewDraft,
  isEditableMobileFilePreview,
  previewWithSavedText,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './preview/mobile-file-preview-editability'
import { MOBILE_FILE_WRITE_RUNTIME_CAPABILITY } from '../../../src/shared/file-write/file-write-disk-precondition'
import { useRouteCapability } from '../worktree/execution-hosts/use-route-capability'
import { useMobileFilePreviewSave } from './preview/use-mobile-file-preview-save'
import { MobileFilePreviewConflictBar } from './preview/MobileFilePreviewConflictBar'
import { filePreviewStylesSheet } from './preview/mobile-file-preview-styles'
import { mobileMarkdownFileLink } from './markdown/mobile-markdown-file-link'
import { useMobileFilePreviewBack } from './preview/use-mobile-file-preview-back'
import {
  filePreviewEditDraftKey,
  MobileFilePreviewEditDraft
} from './preview/MobileFilePreviewEditDraft'
import { dropDocumentEditDraft } from '../drafts/document-edit-draft-rows'
import { useThemedStyles } from '../theme/themed-styles'

type Props = {
  route: MobileFilePreviewRouteState
}

export const MobileFilePreviewScreen = ({ route }: Props) =>
  route.ok && route.params.source === 'chatAttachment' ? (
    <MobileChatAttachmentPreview key={JSON.stringify(route.params)} params={route.params} />
  ) : (
    <WorkspaceFilePreviewScreen route={route} />
  )

function WorkspaceFilePreviewScreen({ route }: Props) {
  const executionHost = useWorkspaceExecutionHost()
  const documentKey = route.ok
    ? [
        route.params.hostId,
        executionHost,
        sourceKeyForPreview(previewSourceFromRoute(route.params))
      ]
    : ['invalid', route.message]
  return <MobileFilePreviewDocument key={JSON.stringify(documentKey)} route={route} />
}

function MobileFilePreviewDocument({ route }: Props) {
  const styles = useThemedStyles(filePreviewStylesSheet)
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  // Use the shared route handoff to keep this screen within the bundle asset budget.
  const router = useWorkspaceRouteHandoff()
  const previewParams = route.ok ? route.params : null
  const { client, state: connState } = useWorkspaceClient(previewParams?.hostId)
  const forceReconnect = useForceReconnect()
  const [preview, setPreview] = useState<MobileFilePreviewResult>(() =>
    route.ok
      ? { status: 'loading', message: t('files.filePreviewScreen.loading', 'Loading preview...') }
      : previewError(route.message)
  )
  const draftSourceKeyRef = useRef<string | null>(null)
  const routePreviewSource = useMemo(
    () => (previewParams ? previewSourceFromRoute(previewParams) : null),
    [previewParams]
  )
  const [previewSource, setPreviewSource] = useState(routePreviewSource)
  const previewSourceKey = useMemo(() => sourceKeyForPreview(previewSource), [previewSource])
  const routePreviewSourceKey = useMemo(
    () => sourceKeyForPreview(routePreviewSource),
    [routePreviewSource]
  )
  const previewSourceKeyRef = useRef(previewSourceKey)
  // Grant-only refreshes keep the source key, so loads read the source here instead of re-running.
  const previewSourceRef = useRef(previewSource)
  const previewLoadRevisionRef = useRef(0)
  const lineColumn = useMemo(
    () =>
      previewParams
        ? normalizeMobileFilePreviewLineColumn(previewParams.line, previewParams.column)
        : null,
    [previewParams]
  )

  // Re-seed from the route during render so a route change never paints the previous source.
  const [seededRouteSource, setSeededRouteSource] = useState(routePreviewSource)
  if (seededRouteSource !== routePreviewSource) {
    setSeededRouteSource(routePreviewSource)
    setPreviewSource(routePreviewSource)
  }

  useEffect(() => {
    previewSourceKeyRef.current = previewSourceKey
    previewSourceRef.current = previewSource
  })

  const routeWritesFiles = useRouteCapability(MOBILE_FILE_WRITE_RUNTIME_CAPABILITY)
  const [editRequested, setEditRequested] = useState(false)
  const isArtifact = previewSource?.source === 'terminalArtifact'
  const canEdit =
    previewSource !== null &&
    isEditableMobileFilePreview(
      preview,
      previewSource.source === 'terminalArtifact'
        ? previewSource.readOnly === true
        : !routeWritesFiles
    )
  // Artifacts open in the editor; workspace files open to read, and edit on request.
  const editing = canEdit && (isArtifact || editRequested)
  const draftLoaded = draftSourceKeyRef.current === previewSourceKey
  const onSaved = useCallback((fileText: string, draftUnchanged: boolean) => {
    setPreview((current) => previewWithSavedText(current, fileText))
    // Typing during the save keeps the editor open on the newer draft.
    if (draftUnchanged) {
      setEditRequested(false)
    }
  }, [])
  const {
    draftContent,
    setDraftContent,
    savedContent,
    draftContentRef,
    savedContentRef,
    conflict,
    saveError,
    setSaveError,
    saving,
    acceptLoaded,
    revertDraft,
    save
  } = useMobileFilePreviewSave({
    client,
    source: previewSource,
    canWrite: editing && draftLoaded,
    onSourceRefreshed: setPreviewSource,
    onSaved
  })

  const loadPreview = useCallback(async () => {
    const revision = ++previewLoadRevisionRef.current
    const loadSourceKey = previewSourceKey
    const loadSource = previewSourceRef.current
    const isCurrent = () =>
      revision === previewLoadRevisionRef.current && previewSourceKeyRef.current === loadSourceKey
    if (!previewParams || !loadSource || loadSourceKey !== routePreviewSourceKey) {
      setPreview(previewError(route.ok ? '' : route.message))
      return
    }
    const preserveDirtyDraft =
      draftSourceKeyRef.current === previewSourceKey &&
      draftContentRef.current !== savedContentRef.current
    if (!client || connState !== 'connected') {
      if (preserveDirtyDraft) {
        setSaveError(translate('common.waitingForHost', 'Waiting for host…'))
        return
      }
      setPreview({
        status: 'waiting',
        message: translate('common.waitingForHost', 'Waiting for host…'),
        reconnect: true
      })
      return
    }
    if (!preserveDirtyDraft) {
      setPreview({
        status: 'loading',
        message: translate('files.filePreviewScreen.loading', 'Loading preview...')
      })
    }
    setSaveError('')
    try {
      const result = await loadMobileFilePreview(client, loadSource, undefined, {
        isCurrent,
        onTerminalArtifactSourceRefreshed: (source) => {
          if (isCurrent()) {
            previewSourceRef.current = source
            setPreviewSource(source)
          }
        },
        refreshGrant: true
      })
      if (!isCurrent()) {
        return
      }
      if (shouldKeepDirtyDraftOnPreviewLoadResult(preserveDirtyDraft, result)) {
        setSaveError(result.message)
        return
      }
      // A refreshed preview can become truncated or binary while this editor owns a dirty draft.
      if (preserveDirtyDraft) {
        return
      }
      const loadedContent =
        result.status === 'ready' && result.kind !== 'image' && result.kind !== 'media'
          ? result.content
          : result.status === 'empty'
            ? ''
            : null
      if (loadedContent !== null) {
        acceptLoaded(loadedContent)
        draftSourceKeyRef.current = previewSourceKey
      }
      setPreview(result)
    } catch (err) {
      if (!isCurrent()) {
        return
      }
      const message = err instanceof Error ? err.message : null
      if (preserveDirtyDraft) {
        setSaveError(
          message ?? translate('files.filePreviewScreen.loadFailed', 'Unable to load preview')
        )
        return
      }
      setPreview(previewError(message ?? ''))
    }
  }, [
    acceptLoaded,
    client,
    connState,
    draftContentRef,
    previewParams,
    previewSourceKey,
    route,
    routePreviewSourceKey,
    savedContentRef,
    setSaveError
  ])

  useEffect(() => {
    void loadPreview()
    return () => {
      previewLoadRevisionRef.current += 1
    }
  }, [loadPreview])

  const retry = useMemo(
    () =>
      connectionRetryAction({
        hostId: previewParams?.hostId,
        needsReconnect:
          preview.status === 'waiting' ||
          (preview.status === 'error' && preview.reconnect) ||
          connState !== 'connected',
        forceReconnect,
        reload: () => void loadPreview()
      }),
    [connState, forceReconnect, loadPreview, preview, previewParams]
  )

  const displayPath =
    previewParams?.source === 'terminalArtifact'
      ? (previewParams.absolutePath ?? '')
      : (previewParams?.relativePath ?? '')
  const title = previewParams?.name ?? displayNameFromPreviewPath(displayPath)
  const worktreeLabel = getWorktreeLabel(
    previewParams?.worktreeName,
    previewParams?.worktreeId ?? '',
    t
  )
  const [markdownMode, setMarkdownMode] = useMarkdownPreviewMode(displayPath, lineColumn?.line)
  const canSave = editing && draftLoaded && draftContent !== savedContent
  const hasUnsavedDraft = hasUnsavedMobileFilePreviewDraft({
    draftSourceKey: draftSourceKeyRef.current,
    previewSourceKey,
    draftContent,
    savedContent
  })

  // Unmount retires pending saves; a refused back keeps the document and its save alive.
  const leave = useCallback(() => router.back(), [router])
  const editDraftKey = filePreviewEditDraftKey(previewSource, previewParams?.hostId, executionHost)
  const dropEditDraft = () => editDraftKey && dropDocumentEditDraft(editDraftKey)
  const { confirmingDiscard, requestBack, stay, discard } = useMobileFilePreviewBack({
    hasUnsavedDraft,
    leave,
    onDiscard: dropEditDraft
  })
  // Reload, once confirmed, drops the draft for what disk holds now.
  const reloadFromDisk = () => {
    revertDraft()
    dropEditDraft()
    void loadPreview()
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <NavBar
          leading={
            <NavBarButton
              icon={ChevronLeft}
              onPress={requestBack}
              accessibilityLabel={t('files.filePreviewScreen.backToFiles', 'Back to files')}
            />
          }
          title={title || t('files.filePreviewScreen.title', 'Preview')}
          subtitle={previewParams ? worktreeLabel : undefined}
          trailing={
            editing ? (
              <NavBarButton
                icon={Save}
                onPress={() => void save('save')}
                disabled={!canSave || saving || conflict !== null}
                accessibilityLabel={
                  isArtifact
                    ? t('files.filePreviewScreen.saveArtifact', 'Save terminal artifact')
                    : t('files.filePreviewScreen.saveFile', 'Save file')
                }
              />
            ) : canEdit ? (
              <NavBarButton
                icon={Pencil}
                onPress={() => setEditRequested(true)}
                accessibilityLabel={t('files.filePreviewScreen.editFile', 'Edit file')}
              />
            ) : null
          }
          accessory={
            preview.status === 'ready' && preview.kind === 'markdown' && !editing ? (
              <MobileMarkdownPreviewModeBar
                mode={markdownMode}
                onModeChange={setMarkdownMode}
                relativePath={displayPath}
                content={preview.content}
                truncated={preview.truncated}
              />
            ) : null
          }
        />
      </SafeAreaView>
      <MobileFilePreviewBody
        preview={preview}
        client={client}
        worktreeId={previewSource?.source === 'worktree' ? previewSource.worktreeId : undefined}
        relativePath={displayPath}
        title={title || t('files.filePreviewScreen.fileTitle', 'File')}
        editable={editing}
        markdownMode={markdownMode}
        draftContent={draftContent}
        saveError={saveError}
        lineColumn={lineColumn}
        onDraftChange={setDraftContent}
        onImageError={() =>
          setPreview({
            status: 'error',
            message: t('files.filePreviewScreen.loadFailed', 'Unable to load preview'),
            reconnect: false
          })
        }
        onRetry={retry}
        onOpenFile={(pathText) => {
          const href = previewParams && mobileMarkdownFileLink(previewParams, pathText)
          if (href) {
            router.push(href)
          } else {
            Alert.alert(
              t('files.filePreviewScreen.openFailed', 'Unable to open file'),
              t(
                'files.filePreviewScreen.chooseWorkspaceFile',
                'Choose a file inside this workspace.'
              )
            )
          }
        }}
      />
      <MobileFilePreviewEditDraft
        draftKey={editDraftKey}
        base={draftLoaded ? savedContent : null}
        editable={canEdit}
        live={draftContent}
        onRestore={(content) => {
          setDraftContent(content)
          setEditRequested(true)
        }}
        fallback={
          conflict && editing ? (
            <MobileFilePreviewConflictBar
              hostId={previewParams?.hostId ?? ''}
              conflict={conflict}
              saving={saving}
              onReload={reloadFromDisk}
              onOverwrite={() => void save('overwrite')}
            />
          ) : null
        }
      />
      <MobileFilePreviewDiscardModal
        visible={confirmingDiscard}
        saving={saving}
        onConfirm={discard}
        onCancel={stay}
      />
    </View>
  )
}
