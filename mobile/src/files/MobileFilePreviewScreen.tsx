import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, BackHandler, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, Save } from 'lucide-react-native'
import { getWorktreeLabel } from '../session/worktree-label'
import { colors, spacing } from '../theme/mobile-theme'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import type { ConnectionState } from '../transport/types'
import {
  previewError,
  type MobileFilePreviewSource,
  type MobileFilePreviewResult
} from './mobile-file-preview-request'
import { MobileFilePreviewBody } from './MobileFilePreviewBody'
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
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import { defaultHostFilePreviewOperations } from './default-host-file-preview-operations'

type Props = {
  route: MobileFilePreviewRouteState
  operations?: HostFilePreviewOperations
  connectionState?: ConnectionState
  nativeHostBinding?: boolean
}

export function MobileFilePreviewScreen({
  route,
  operations: operationsProp,
  connectionState,
  nativeHostBinding = true
}: Props) {
  const router = useRouter()
  const previewParams = route.ok ? route.params : null
  const previewHostId = previewParams?.hostId
  const nativeHost = useHostClient(nativeHostBinding ? previewHostId : undefined)
  const forceReconnect = useForceReconnect()
  const operations = useMemo(
    () =>
      operationsProp ??
      (nativeHost.client && previewHostId
        ? defaultHostFilePreviewOperations(nativeHost.client, () => forceReconnect(previewHostId))
        : null),
    [forceReconnect, nativeHost.client, operationsProp, previewHostId]
  )
  // Why: `operations` is null in exactly the disconnected state Retry exists for.
  const reconnect = useCallback(
    () =>
      operations
        ? operations.reconnect()
        : previewHostId
          ? forceReconnect(previewHostId)
          : Promise.resolve(),
    [forceReconnect, operations, previewHostId]
  )
  const connState = connectionState ?? nativeHost.state
  const handleOpenExternalUrl = useCallback(
    (url: string) => {
      void operations?.openExternalUrl(url).catch(() => {})
    },
    [operations]
  )
  const [preview, setPreview] = useState<MobileFilePreviewResult>(() =>
    route.ok ? { status: 'loading', message: 'Loading preview...' } : previewError(route.message)
  )
  const [draftContent, setDraftContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const draftContentRef = useRef(draftContent)
  const savedContentRef = useRef(savedContent)
  const draftSourceKeyRef = useRef<string | null>(null)
  const { width, height } = useWindowDimensions()
  const routeWorktreeId = previewParams?.worktreeId
  const routeSource = previewParams?.source
  const routeRelativePath = previewParams?.relativePath
  const routeAbsolutePath = previewParams?.absolutePath
  const routeGrantId = previewParams?.grantId
  const routeTerminal = previewParams?.terminal
  const routePathText = previewParams?.pathText
  const routeCwd = previewParams?.cwd
  const routePreviewSource = useMemo(
    () =>
      previewHostId && routeWorktreeId
        ? previewSourceFromRoute({
            hostId: previewHostId,
            worktreeId: routeWorktreeId,
            source: routeSource,
            relativePath: routeRelativePath,
            absolutePath: routeAbsolutePath,
            grantId: routeGrantId,
            terminal: routeTerminal,
            pathText: routePathText,
            cwd: routeCwd
          })
        : null,
    [
      previewHostId,
      routeAbsolutePath,
      routeCwd,
      routeGrantId,
      routePathText,
      routeRelativePath,
      routeSource,
      routeTerminal,
      routeWorktreeId
    ]
  )
  const [previewSource, setPreviewSource] = useState<MobileFilePreviewSource | null>(
    routePreviewSource
  )
  const previewSourceKey = useMemo(() => sourceKeyForPreview(previewSource), [previewSource])
  const routePreviewSourceKey = useMemo(
    () => sourceKeyForPreview(routePreviewSource),
    [routePreviewSource]
  )
  const hasPreviewParams = previewParams !== null
  const routeErrorMessage = route.ok ? null : route.message
  const previewSourceKeyRef = useRef(previewSourceKey)
  const lineColumn = useMemo(
    () =>
      previewParams
        ? normalizeMobileFilePreviewLineColumn(previewParams.line, previewParams.column)
        : null,
    [previewParams]
  )

  useEffect(() => {
    setPreviewSource(routePreviewSource)
    draftSourceKeyRef.current = null
  }, [routePreviewSource])

  useEffect(() => {
    previewSourceKeyRef.current = previewSourceKey
  }, [previewSourceKey])

  useEffect(() => {
    draftContentRef.current = draftContent
  }, [draftContent])

  useEffect(() => {
    savedContentRef.current = savedContent
  }, [savedContent])

  const loadPreview = useCallback(async () => {
    const loadSourceKey = previewSourceKey
    if (!hasPreviewParams || !previewSource || loadSourceKey !== routePreviewSourceKey) {
      setPreview(previewError(routeErrorMessage ?? 'Unable to load preview'))
      return
    }
    const preserveDirtyDraft =
      draftSourceKeyRef.current === previewSourceKey &&
      draftContentRef.current !== savedContentRef.current
    if (!operations || connState !== 'connected') {
      if (preserveDirtyDraft) {
        setSaveError('Waiting for desktop...')
        return
      }
      setPreview({ status: 'waiting', message: 'Waiting for desktop...', reconnect: true })
      return
    }
    if (!preserveDirtyDraft) {
      setPreview({ status: 'loading', message: 'Loading preview...' })
    }
    setSaveError('')
    try {
      const result = await operations.load(previewSource, {
        onTerminalArtifactSourceRefreshed: setPreviewSource
      })
      if (previewSourceKeyRef.current !== loadSourceKey) {
        return
      }
      if (shouldKeepDirtyDraftOnPreviewLoadResult(preserveDirtyDraft, result)) {
        setSaveError(result.message)
        return
      }
      const loadedContent =
        result.status === 'ready' && result.kind !== 'image'
          ? result.content
          : result.status === 'empty'
            ? ''
            : null
      if (loadedContent !== null) {
        if (!preserveDirtyDraft) {
          setDraftContent(loadedContent)
          setSavedContent(loadedContent)
        }
        draftSourceKeyRef.current = previewSourceKey
      }
      setPreview(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load preview'
      if (preserveDirtyDraft) {
        setSaveError(message)
        return
      }
      setPreview(previewError(message))
    }
  }, [
    connState,
    hasPreviewParams,
    operations,
    previewSource,
    previewSourceKey,
    routeErrorMessage,
    routePreviewSourceKey
  ])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const retry = useCallback(async () => {
    if (!previewParams) {
      void loadPreview()
      return
    }
    if (
      preview.status === 'waiting' ||
      (preview.status === 'error' && preview.reconnect) ||
      connState !== 'connected'
    ) {
      await reconnect()
      return
    }
    void loadPreview()
  }, [connState, loadPreview, preview, previewParams, reconnect])

  const displayPath =
    previewParams?.source === 'terminalArtifact'
      ? (previewParams.absolutePath ?? '')
      : (previewParams?.relativePath ?? '')
  const title = previewParams?.name ?? displayNameFromPreviewPath(displayPath)
  const worktreeLabel = getWorktreeLabel(
    previewParams?.worktreeName,
    previewParams?.worktreeId ?? ''
  )
  const meta = previewParams ? `${worktreeLabel} - ${displayPath}` : 'Preview'
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
    if (!operations || previewSource?.source !== 'terminalArtifact' || !canSaveArtifact || saving) {
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const result = await operations.saveTerminalArtifact(previewSource, draftContent, {
        baseContent: savedContent,
        onTerminalArtifactSourceRefreshed: setPreviewSource
      })
      if (result.status === 'saved') {
        setSavedContent(draftContent)
      } else {
        setSaveError(saveErrorMessageFromPreviewResult(result))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save file'
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [canSaveArtifact, draftContent, operations, previewSource, savedContent, saving])

  const requestBack = useCallback(() => {
    if (!hasUnsavedTerminalArtifactDraft) {
      router.back()
      return true
    }
    Alert.alert('Discard changes?', 'Unsaved edits will be lost.', [
      { text: 'Stay', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() }
    ])
    return true
  }, [hasUnsavedTerminalArtifactDraft, router])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', requestBack)
    return () => subscription.remove()
  }, [requestBack])

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={requestBack}
            hitSlop={8}
            accessibilityLabel="Back to files"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              {title || 'Preview'}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          </View>
          {isEditableTerminalArtifact ? (
            <Pressable
              style={[styles.saveButton, (!canSaveArtifact || saving) && styles.saveButtonDisabled]}
              onPress={() => void saveArtifact()}
              disabled={!canSaveArtifact || saving}
              accessibilityLabel="Save terminal artifact"
            >
              <Save size={18} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
      <MobileFilePreviewBody
        preview={preview}
        relativePath={displayPath}
        title={title || 'File'}
        editable={isEditableTerminalArtifact}
        draftContent={draftContent}
        saveError={saveError}
        lineColumn={lineColumn}
        imageWidth={Math.max(1, width - spacing.md * 2)}
        imageHeight={Math.max(240, height - 160)}
        onDraftChange={setDraftContent}
        onImageError={() =>
          setPreview({ status: 'error', message: 'Unable to load preview', reconnect: false })
        }
        onOpenLink={handleOpenExternalUrl}
        onRetry={retry}
      />
    </View>
  )
}

function saveErrorMessageFromPreviewResult(result: MobileFilePreviewResult): string {
  return result.status === 'error' || result.status === 'waiting'
    ? result.message
    : 'Unable to save file'
}
