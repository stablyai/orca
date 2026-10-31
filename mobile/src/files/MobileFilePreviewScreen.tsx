import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, View } from 'react-native'
import { SafeAreaView, useSafeAreaFrame } from 'react-native-safe-area-context'
import { ChevronLeft, Save } from 'lucide-react-native'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { getWorktreeLabel } from '../session/worktree-label'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { connectionRetryAction } from '../transport/connection-retry-action'
import {
  loadMobileFilePreview,
  previewError,
  saveMobileTerminalArtifactPreview,
  type MobileFilePreviewSource,
  type MobileFilePreviewResult
} from './mobile-file-preview-request'
import { ConfirmModal } from '../components/ConfirmModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileFilePreviewBody } from './MobileFilePreviewBody'
import {
  MobileMarkdownPreviewModeBar,
  useMarkdownPreviewMode
} from './MobileMarkdownPreviewModeBar'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteState
} from './mobile-file-preview-route'
import { previewSourceFromRoute, sourceKeyForPreview } from './mobile-file-preview-source'
import { normalizeMobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import {
  hasUnsavedMobileTerminalArtifactDraft,
  isEditableMobileTerminalArtifactPreview,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './mobile-file-preview-editability'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { mobileMarkdownFileLink } from './mobile-markdown-file-link'
import { useMobileFilePreviewBack } from './use-mobile-file-preview-back'

type Props = {
  route: MobileFilePreviewRouteState
}

export function MobileFilePreviewScreen({ route }: Props) {
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
  const t = useMobileTranslation()
  useMobileColorScheme()
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
  const [draftContent, setDraftContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const saveRevisionRef = useRef(0)
  useLayoutEffect(
    () => () => {
      saveRevisionRef.current += 1
    },
    []
  )
  const draftContentRef = useRef(draftContent)
  const savedContentRef = useRef(savedContent)
  const draftSourceKeyRef = useRef<string | null>(null)
  const { width, height } = useSafeAreaFrame()
  const routePreviewSource = useMemo(
    () => (previewParams ? previewSourceFromRoute(previewParams) : null),
    [previewParams]
  )
  const [previewSource, setPreviewSource] = useState<MobileFilePreviewSource | null>(
    routePreviewSource
  )
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

  useEffect(() => {
    setPreviewSource(routePreviewSource)
  }, [routePreviewSource])

  useEffect(() => {
    previewSourceKeyRef.current = previewSourceKey
  }, [previewSourceKey])

  useEffect(() => {
    previewSourceRef.current = previewSource
  }, [previewSource])

  useEffect(() => {
    draftContentRef.current = draftContent
  }, [draftContent])

  useEffect(() => {
    savedContentRef.current = savedContent
  }, [savedContent])

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
        setSaveError(translate('files.filePreviewScreen.waiting', 'Waiting for desktop...'))
        return
      }
      setPreview({
        status: 'waiting',
        message: translate('files.filePreviewScreen.waiting', 'Waiting for desktop...'),
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
        setDraftContent(loadedContent)
        setSavedContent(loadedContent)
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
  }, [client, connState, previewParams, previewSourceKey, route, routePreviewSourceKey])

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
    previewParams?.worktreeId ?? ''
  )
  const [markdownMode, setMarkdownMode] = useMarkdownPreviewMode(displayPath, lineColumn?.line)
  const isEditableTerminalArtifact =
    previewSource?.source === 'terminalArtifact' &&
    isEditableMobileTerminalArtifactPreview(preview, previewSource.readOnly === true)
  const canSaveArtifact =
    isEditableTerminalArtifact &&
    draftSourceKeyRef.current === previewSourceKey &&
    draftContent !== savedContent
  const hasUnsavedTerminalArtifactDraft = hasUnsavedMobileTerminalArtifactDraft({
    source: previewSource?.source,
    draftSourceKey: draftSourceKeyRef.current,
    previewSourceKey,
    draftContent,
    savedContent
  })

  const saveArtifact = useCallback(async () => {
    if (
      !client ||
      previewSource?.source !== 'terminalArtifact' ||
      !canSaveArtifact ||
      savingRef.current
    ) {
      return
    }
    savingRef.current = true
    const saveRevision = ++saveRevisionRef.current
    const isCurrentSave = () => saveRevisionRef.current === saveRevision
    setSaving(true)
    setSaveError('')
    try {
      const result = await saveMobileTerminalArtifactPreview(client, previewSource, draftContent, {
        baseContent: savedContent,
        isCurrent: isCurrentSave,
        onTerminalArtifactSourceRefreshed: (source) => {
          if (isCurrentSave()) {
            setPreviewSource(source)
          }
        }
      })
      if (!isCurrentSave()) {
        return
      }
      if (result.status === 'saved') {
        setSavedContent(draftContent)
      } else {
        setSaveError(saveErrorMessageFromPreviewResult(result))
      }
    } catch (err) {
      if (!isCurrentSave()) {
        return
      }
      const message =
        err instanceof Error
          ? err.message
          : translate('files.filePreviewScreen.saveFailed', 'Unable to save file')
      setSaveError(message)
    } finally {
      if (isCurrentSave()) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }, [canSaveArtifact, client, draftContent, previewSource, savedContent])

  // Unmount retires pending saves; a refused back keeps the document and its save alive.
  const leave = useCallback(() => router.back(), [router])
  const { confirmingDiscard, requestBack, stay, discard } = useMobileFilePreviewBack({
    hasUnsavedDraft: hasUnsavedTerminalArtifactDraft,
    leave
  })

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
            isEditableTerminalArtifact ? (
              <NavBarButton
                icon={Save}
                onPress={() => void saveArtifact()}
                disabled={!canSaveArtifact || saving}
                accessibilityLabel={t(
                  'files.filePreviewScreen.saveArtifact',
                  'Save terminal artifact'
                )}
              />
            ) : null
          }
          accessory={
            preview.status === 'ready' &&
            preview.kind === 'markdown' &&
            !isEditableTerminalArtifact ? (
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
        editable={isEditableTerminalArtifact}
        markdownMode={markdownMode}
        draftContent={draftContent}
        saveError={saveError}
        lineColumn={lineColumn}
        imageWidth={Math.max(1, width - spacing.md * 2)}
        imageHeight={Math.max(240, height - 160)}
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
      <ConfirmModal
        visible={confirmingDiscard}
        title={t('files.filePreviewScreen.discardTitle', 'Discard changes?')}
        message={
          saving
            ? t(
                'files.filePreviewScreen.discardMessageSaving',
                'The save in progress may not finish. Unsaved edits will be lost.'
              )
            : t('files.filePreviewScreen.discardMessage', 'Unsaved edits will be lost.')
        }
        confirmLabel={t('files.filePreviewScreen.discard', 'Discard')}
        cancelLabel={t('files.filePreviewScreen.stay', 'Stay')}
        destructive
        onConfirm={discard}
        onCancel={stay}
      />
    </View>
  )
}

function saveErrorMessageFromPreviewResult(result: MobileFilePreviewResult): string {
  return result.status === 'error' || result.status === 'waiting'
    ? result.message
    : translate('files.filePreviewScreen.saveFailed', 'Unable to save file')
}
