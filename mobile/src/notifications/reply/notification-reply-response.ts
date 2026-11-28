import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { NOTIFICATION_REPLY_ACTION } from '../../../../src/shared/notifications/notification-reply'
import { sha256 } from '../../../../src/shared/hashing/sha256'
import { parsePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import { editMobileNativeChatDraft } from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { resolveHostIdForFingerprint } from '../payload-identity/push-host-fingerprint'
import { readOrcaPushPayload } from '../payload-identity/push-payload'
import { readNativeNotificationData } from '../payload-identity/native-notification-data'
import { loadHosts } from '../../host-catalog/host-store'
import { sendNotificationReply } from './notification-reply-delivery'
import { completeNativeReply } from './notification-reply-native'
import { showAndroidReplySent } from './android-reply-presentation'
import { translate } from '../../i18n/mobile-i18n'
import { loadMobileNativeChatDrafts } from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence'
import {
  mobileBotGroupDraftKey,
  mobileBotGroupDraftWorkspaceId
} from '../../bots/use-mobile-bot-group-draft'
import {
  botItemCommentDraftKey,
  returnBotItemCommentDraft
} from '../../bots/items/bot-item-comment-drafts'

const PREFIX = 'orca:notificationReply:'
const active = new Map<string, Promise<boolean>>()

export async function restoreNotificationReplyDraft(data: unknown): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !('replyDraftId' in data) ||
    typeof data.replyDraftId !== 'string'
  ) {
    return
  }
  const raw = await AsyncStorage.getItem(PREFIX + data.replyDraftId)
  if (!raw) {
    return
  }
  const saved: unknown = JSON.parse(raw)
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('text' in saved) ||
    typeof saved.text !== 'string' ||
    ('restored' in saved && saved.restored === true)
  ) {
    return
  }
  const payload = readOrcaPushPayload(data)
  const pane = payload?.paneKey ? parsePaneKey(payload.paneKey) : null
  const hostId = payload
    ? resolveHostIdForFingerprint(payload.hostFingerprint, await loadHosts())
    : null
  if (!hostId || !payload?.worktreeId) {
    return
  }
  const text = saved.text
  if (payload.replyTarget?.type === 'bot-item') {
    returnBotItemCommentDraft(botItemCommentDraftKey(hostId, payload.replyTarget.itemUid), text)
    return
  }
  const groupId = payload.replyTarget?.type === 'group' ? payload.replyTarget.groupId : null
  const workspace = groupId ? mobileBotGroupDraftWorkspaceId(groupId) : payload.worktreeId
  const draftKey = groupId
    ? mobileBotGroupDraftKey(hostId, groupId, groupId)
    : pane
      ? `${hostId}\0${workspace}\0${pane.tabId}`
      : null
  if (!draftKey) {
    return
  }
  await loadMobileNativeChatDrafts(hostId, workspace)
  editMobileNativeChatDraft(draftKey, (current) => (current ? `${current}\n${text}` : text))
  await AsyncStorage.setItem(
    PREFIX + data.replyDraftId,
    JSON.stringify({ ...saved, restored: true, at: Date.now() })
  )
}

export function handleNotificationReply(
  response: Notifications.NotificationResponse
): Promise<boolean> {
  if (response.actionIdentifier !== NOTIFICATION_REPLY_ACTION) {
    return Promise.resolve(false)
  }
  const text =
    'userText' in response && typeof response.userText === 'string' ? response.userText : ''
  const data = readNativeNotificationData(response.notification.request)
  const payload = readOrcaPushPayload(data)
  const id = Array.from(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          payload?.hostFingerprint,
          payload?.notificationEpoch,
          payload?.notificationSeq,
          response.notification.request.identifier,
          text
        ])
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  const pending = active.get(id)
  if (pending) {
    return pending
  }
  const result = deliver(response, data, text, id).finally(async () => {
    active.delete(id)
    await completeNativeReply(response.notification.request.identifier)
  })
  active.set(id, result)
  return result
}

async function deliver(
  response: Notifications.NotificationResponse,
  data: unknown,
  text: string,
  id: string
): Promise<boolean> {
  const key = PREFIX + id
  // A duplicate delivery after process death must never submit the terminal text twice.
  if (await AsyncStorage.getItem(key)) {
    return true
  }
  await AsyncStorage.setItem(key, JSON.stringify({ text, state: 'sending', data, at: Date.now() }))
  try {
    await sendNotificationReply(data, text, `notification-reply-${id}`)
  } catch (error) {
    await AsyncStorage.setItem(key, JSON.stringify({ text, state: 'failed', data, at: Date.now() }))
    await showReplyFailure(data, id, error instanceof Error ? error.message : 'Host unreachable')
    return true
  }
  await AsyncStorage.setItem(key, JSON.stringify({ state: 'sent', at: Date.now() }))
  await showAndroidReplySent(response).catch(() => {})
  await Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(
    () => {}
  )
  return true
}

async function showReplyFailure(data: unknown, id: string, reason: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: translate('notifications.reply.failed', 'Reply not sent'),
      body: translate('notifications.reply.failedReason', 'Reply not sent: {{reason}}', { reason }),
      data: { ...readOrcaPushPayload(data), replyDraftId: id },
      sound: 'default'
    },
    trigger: null
  })
}

export async function recoverInterruptedNotificationReplies(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX))
  for (const [key, raw] of await AsyncStorage.multiGet(keys)) {
    if (!raw) {
      continue
    }
    let saved: unknown
    try {
      saved = JSON.parse(raw)
    } catch {
      continue
    }
    if (!saved || typeof saved !== 'object' || !('state' in saved)) {
      continue
    }
    const id = key.slice(PREFIX.length)
    if (saved.state === 'sending' && !active.has(id) && 'data' in saved && 'text' in saved) {
      await AsyncStorage.setItem(key, JSON.stringify({ ...saved, state: 'failed', at: Date.now() }))
      await showReplyFailure(
        saved.data,
        id,
        'Delivery unconfirmed; check the chat before sending again'
      )
    } else if (
      (saved.state === 'sent' || ('restored' in saved && saved.restored === true)) &&
      'at' in saved &&
      typeof saved.at === 'number' &&
      Date.now() - saved.at > 7 * 24 * 60 * 60 * 1000
    ) {
      await AsyncStorage.removeItem(key)
    }
  }
}
