import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { AttachmentTextScrollView } from './AttachmentTextScrollView'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkspaceRouteHandoff } from '../../navigation/workspace-route-handoff'
import { useWorkspaceClient } from '../../worktree/execution-hosts/use-workspace-client'
import { createAttachmentTextPreviewHook } from '../../../../src/shared/attachment-text/use-attachment-text-preview'
import { hasBinaryFileExtension } from '../../../../src/shared/file-preview/binary-file-extensions'
import * as Sharing from 'expo-sharing'
import { downloadMobileChatAttachment } from './mobile-chat-attachment-download'
import { MobileAttachmentFileIcon } from './MobileAttachmentFileIcon'
import { colors } from '../../theme/mobile-theme'
import { chatTextAttachmentName } from '../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../../src/shared/mobile-bridge/mobile-bridge-frame-bytes'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { chatAttachmentPreviewStyles as styles } from '../preview/mobile-file-preview-styles'
import type { AttachmentTextRead } from '../../../../src/shared/attachment-text/attachment-text-source'
import type { MobileFilePreviewRouteParams } from '../preview/mobile-file-preview-route'

const useAttachmentTextPreview = createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
})

export function MobileChatAttachmentPreview({ params }: { params: MobileFilePreviewRouteParams }) {
  return hasBinaryFileExtension(params.absolutePath ?? '') ? (
    <MobileBinaryAttachmentInfo params={params} />
  ) : (
    <MobileChatTextAttachmentPreview params={params} />
  )
}

// The browser build has no file system to copy into, so saving is a native-app action.
const CAN_SAVE_ATTACHMENTS = Platform.OS !== 'web'

function useChatAttachmentShare(read: AttachmentTextRead, path: string) {
  const t = useMobileTranslation()
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  // Leaving the preview, or switching files, stops a download so it cannot open a share sheet afterwards.
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
      setProgress(null)
    },
    [read, path]
  )
  const share = async () => {
    setError('')
    setProgress(0)
    const controller = new AbortController()
    active.current = controller
    try {
      const uri = await downloadMobileChatAttachment(read, {
        path,
        onProgress: setProgress,
        signal: controller.signal
      })
      if (!controller.signal.aborted) {
        await Sharing.shareAsync(uri)
      }
    } catch (cause) {
      if (active.current === controller) {
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : t('chat.textAttachmentPreview.shareFailed', 'Unable to open this file. Try again.')
        )
      }
    } finally {
      if (active.current === controller) {
        active.current = null
        setProgress(null)
      }
    }
  }
  return { share, progress, error }
}

// Videos, archives and documents have no text to show; they can be copied to the phone and handed to another app.
function MobileBinaryAttachmentInfo({ params }: { params: MobileFilePreviewRouteParams }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useWorkspaceRouteHandoff()
  const { client, state } = useWorkspaceClient(params.hostId)
  const connectedAt = client?.getLastConnectedAt()
  const generation = client?.getGeneration?.()
  const read = useMemo(
    () => createMobileChatAttachmentReader(client),
    [client, connectedAt, generation, state]
  )
  const path = params.absolutePath ?? ''
  const name = chatTextAttachmentName(path)
  const { share, progress, error } = useChatAttachmentShare(read, path)
  return (
    <SafeAreaView edges={['bottom']} style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.header}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.meta}>{t('common.back', 'Back')}</Text>
          </Pressable>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {name}
            </Text>
            <Text style={styles.meta}>
              {t('chat.textAttachmentPreview.fileAttachment', 'File attachment')}
            </Text>
          </View>
        </View>
      </SafeAreaView>
      <View style={styles.binaryBody}>
        <MobileAttachmentFileIcon
          name={name}
          size={40}
          color={colors.textSecondary}
          strokeWidth={1.75}
        />
        <Text style={styles.meta}>
          {t(
            'chat.textAttachmentPreview.binaryInfoSave',
            'This file is on the host and the agent can read it. It cannot be previewed here, but you can save it or open it in another app.'
          )}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: progress !== null }}
          disabled={progress !== null || !client || !CAN_SAVE_ATTACHMENTS}
          onPress={() => void share()}
          style={[
            styles.backButton,
            (progress !== null || !client || !CAN_SAVE_ATTACHMENTS) && styles.saveButtonDisabled
          ]}
        >
          <Text style={styles.meta}>
            {progress === null
              ? t('chat.textAttachmentPreview.saveOrShare', 'Save or share')
              : t('chat.textAttachmentPreview.downloading', 'Downloading {{percent}}%', {
                  percent: Math.min(100, Math.floor(progress * 100))
                })}
          </Text>
        </Pressable>
        {CAN_SAVE_ATTACHMENTS ? null : (
          <Text style={styles.meta}>
            {t(
              'chat.textAttachmentPreview.saveNativeOnly',
              'Saving files is not available in this view yet.'
            )}
          </Text>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

function MobileChatTextAttachmentPreview({ params }: { params: MobileFilePreviewRouteParams }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, state } = useWorkspaceClient(params.hostId)
  const router = useWorkspaceRouteHandoff()
  const clipboard = useClipboardWriter()
  const path = params.absolutePath ?? ''
  const connectedAt = client?.getLastConnectedAt()
  const generation = client?.getGeneration?.()
  const read = useMemo(
    () => createMobileChatAttachmentReader(client),
    [client, connectedAt, generation, state]
  )
  const { source, revision, busy, error, setError, setBusy, demand, retry } =
    useAttachmentTextPreview(path, read)
  const { share, progress, error: shareError } = useChatAttachmentShare(read, path)
  // Reserve envelope space, then validate actual JSON escaping before publishing to the phone clipboard.
  const smallCopy = source.size !== null && source.size + 4096 <= MOBILE_BRIDGE_MAX_FRAME_BYTES
  const copy = async () => {
    setError('')
    if (source.disposed) {
      return
    }
    setBusy(true)
    try {
      const text = await source.copyText()
      if (
        new TextEncoder().encode(JSON.stringify({ value: text })).length + 4096 >
        MOBILE_BRIDGE_MAX_FRAME_BYTES
      ) {
        throw new Error('This attachment is too large to copy. Use Save instead.')
      }
      source.assertCurrent()
      await clipboard.writeText(text)
    } catch (cause) {
      if (!source.disposed) {
        setError(cause instanceof Error ? cause.message : 'Unable to copy attachment. Try again.')
      }
    } finally {
      if (!source.disposed) {
        setBusy(false)
      }
    }
  }

  const action = (label: string, disabled: boolean, onActivate: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onActivate}
      style={[styles.backButton, disabled && styles.saveButtonDisabled]}
    >
      <Text style={styles.meta}>{label}</Text>
    </Pressable>
  )
  return (
    <SafeAreaView edges={['bottom']} style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.header}>
        <View style={styles.topBar}>
          {action(t('common.back', 'Back'), false, () => {
            source.dispose()
            router.back()
          })}
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {chatTextAttachmentName(
                path,
                t('chat.textAttachmentPreview.pastedText', 'Pasted text')
              )}
            </Text>
            <Text style={styles.meta}>
              {source.size === null
                ? t('chat.textAttachmentPreview.textAttachment', 'Text attachment')
                : t('chat.textAttachmentPreview.byteSize', '{{size}} bytes', {
                    size: source.size.toLocaleString(getUiIntlLocale())
                  })}
            </Text>
          </View>
        </View>
      </SafeAreaView>
      <View style={styles.topBar}>
        {action(t('common.copy', 'Copy'), busy || !smallCopy, () => void copy())}
        {action(
          progress === null
            ? t('common.save', 'Save')
            : t('chat.textAttachmentPreview.downloading', 'Downloading {{percent}}%', {
                percent: Math.min(100, Math.floor(progress * 100))
              }),
          progress !== null || !CAN_SAVE_ATTACHMENTS,
          () => void share()
        )}
        {action(t('common.retry', 'Retry'), busy, retry)}
      </View>
      {smallCopy ? null : (
        <Text style={styles.meta}>
          {t(
            'chat.textAttachmentPreview.fullCopyUseSave',
            'This attachment is too large to copy in full. Use Save to get the whole file.'
          )}
        </Text>
      )}
      {shareError ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {shareError}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {formatAttachmentPreviewError(error, t)}
        </Text>
      ) : null}
      <AttachmentTextScrollView source={source} revision={revision} demand={demand} />
    </SafeAreaView>
  )
}

function formatAttachmentPreviewError(message: string, t: Translate): string {
  switch (message) {
    case 'Unreadable attachment reply. Try again.':
      return t(
        'chat.textAttachmentPreview.unreadableReply',
        'Unreadable attachment reply. Try again.'
      )
    case 'Attachment changed or its reply was incomplete. Close it and try again.':
      return t(
        'chat.textAttachmentPreview.incompleteReply',
        'Attachment changed or its reply was incomplete. Close it and try again.'
      )
    case 'This file cannot be previewed as text. Save it to open it in another app.':
      return t(
        'chat.textAttachmentPreview.notText',
        'This file cannot be previewed as text. Save it to open it in another app.'
      )
    case 'Unable to open attachment. Try again.':
      return t('chat.textAttachmentPreview.openFailed', 'Unable to open attachment. Try again.')
    case 'This host cannot open text attachments yet. Update Orca on that host, then retry.':
      return t(
        'chat.textAttachmentPreview.hostUpdate',
        'This host cannot open text attachments yet. Update Orca on that host, then retry.'
      )
    case 'This file is too large to copy. Save it instead.':
      return t(
        'chat.textAttachmentPreview.copyTooLarge',
        'This file is too large to copy. Save it instead.'
      )
    case 'Connection changed. Retry to reopen the attachment.':
      return t(
        'chat.textAttachmentPreview.connectionChanged',
        'Connection changed. Retry to reopen the attachment.'
      )
    case 'The attachment host changed. Close it and reopen it.':
      return t(
        'chat.textAttachmentPreview.hostChanged',
        'The attachment host changed. Close it and reopen it.'
      )
    case 'Unable to read this attachment. Reconnect and try again. The file may have been removed or changed.':
      return t(
        'chat.textAttachmentPreview.readFailed',
        'Unable to read this attachment. Reconnect and try again. The file may have been removed or changed.'
      )
    case 'This attachment is too large to copy. Use Save instead.':
      return t(
        'chat.textAttachmentPreview.copyFrameUseSave',
        'This attachment is too large to copy. Use Save instead.'
      )
    case 'Unable to copy attachment. Try again.':
      return t('chat.textAttachmentPreview.copyFailed', 'Unable to copy attachment. Try again.')
    default:
      return message
  }
}
