import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Translate } from '../i18n/mobile-i18n'
import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMemo, useState, useEffect, useCallback } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { createAttachmentTextPreviewHook } from '../../../src/shared/use-attachment-text-preview'
import { chatTextAttachmentName } from '../../../src/shared/native-chat-text-attachment-references'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../src/shared/mobile-bridge-frame-bytes'
import { useClipboardWriter } from '../platform/clipboard'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'

const useAttachmentTextPreview = createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
})

export function MobileChatAttachmentPreview({ params }: { params: MobileFilePreviewRouteParams }) {
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
  const { source, display, busy, error, setError, setBusy, load, retry } = useAttachmentTextPreview(
    path,
    read
  )
  // Reserve envelope space, then validate actual JSON escaping before publishing to the phone clipboard.
  const smallCopy = source.size !== null && source.size + 4096 <= MOBILE_BRIDGE_MAX_FRAME_BYTES
  const copy = async () => {
    setBusy(true)
    try {
      const text = await source.copyText()
      if (
        new TextEncoder().encode(JSON.stringify({ value: text })).length + 4096 >
        MOBILE_BRIDGE_MAX_FRAME_BYTES
      ) {
        throw new Error('Full Copy for this attachment needs the upcoming phone update.')
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

  const action = (label: string, disabled: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.backButton, disabled && styles.saveButtonDisabled]}
    >
      <Text style={styles.meta}>{label}</Text>
    </Pressable>
  )
  let segmentOffset = 0
  const segments = display?.segments.map((segment) => {
    const key = `${path}:${display.page}:${display.subpage}:${segmentOffset}`
    segmentOffset += segment.length
    return (
      <Text key={key} selectable style={styles.textPreview}>
        {segment.replace(/\n$/, '') || '\u00a0'}
      </Text>
    )
  })
  return (
    <View style={styles.container}>
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
        {action(t('common.save', 'Save'), true, () => {})}
        {action(t('common.retry', 'Retry'), busy, retry)}
      </View>
      <Text style={styles.meta}>
        {smallCopy
          ? t('chat.textAttachmentPreview.saveUpdate', 'Save will be available in a phone update.')
          : t(
              'chat.textAttachmentPreview.fullCopySaveUpdate',
              'Full Copy and Save for this attachment will be available in a phone update.'
            )}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {formatAttachmentPreviewError(error, t)}
        </Text>
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.textContent}>
        {segments}
      </ScrollView>
      <View style={[styles.topBar, { flexWrap: 'wrap' }]}>
        {action(
          t('chat.textAttachmentPreview.first', 'First'),
          busy || !display,
          () => void load(0)
        )}
        {action(
          t('chat.textAttachmentPreview.prev', 'Prev'),
          busy || !display || (display.page === 0 && display.subpage === 0),
          () =>
            display &&
            void load(
              display.subpage ? display.page : display.page - 1,
              display.subpage ? display.subpage - 1 : Number.MAX_SAFE_INTEGER
            )
        )}
        <TextInput
          accessibilityLabel={t('chat.textAttachmentPreview.attachmentPage', 'Attachment page')}
          style={styles.meta}
          keyboardType="number-pad"
          value={String((display?.page ?? 0) + 1)}
          editable={!busy}
          onChangeText={(value) => {
            const page = Number(value)
            if (Number.isInteger(page) && page >= 1 && page <= source.pageCount) {
              void load(page - 1)
            }
          }}
        />
        <Text style={styles.meta}>
          / {source.pageCount}
          {display ? ` (${display.subpage + 1}/${display.subpages})` : ''}
        </Text>
        {action(
          t('chat.textAttachmentPreview.next', 'Next'),
          busy ||
            !display ||
            (display.page + 1 === source.pageCount && display.subpage + 1 === display.subpages),
          () =>
            display &&
            void load(
              display.subpage + 1 < display.subpages ? display.page : display.page + 1,
              display.subpage + 1 < display.subpages ? display.subpage + 1 : 0
            )
        )}
        {action(
          t('chat.textAttachmentPreview.last', 'Last'),
          busy || !display,
          () => void load(source.pageCount - 1, Number.MAX_SAFE_INTEGER)
        )}
      </View>
    </View>
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
    case 'Full Copy for this attachment needs the upcoming phone update.':
      return t(
        'chat.textAttachmentPreview.copyFrame',
        'Full Copy for this attachment needs the upcoming phone update.'
      )
    case 'Unable to copy attachment. Try again.':
      return t('chat.textAttachmentPreview.copyFailed', 'Unable to copy attachment. Try again.')
    default:
      return message
  }
}
