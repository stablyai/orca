import {
  NotificationReplyFailure,
  notificationReplyFailureMessage
} from './notification-reply-failure'
import { runKeyedSerializedOperation } from '../../../../src/shared/concurrency/keyed-serialized-operations'
import { notificationReplyRecords } from './notification-reply-record-store'
import * as Notifications from 'expo-notifications'
import { NOTIFICATION_REPLY_ACTION } from '../../../../src/shared/notifications/notification-reply'
import { notificationReplyResponseId } from './notification-reply-identity'
import { readNotificationReplyDraftRecord } from './notification-reply-draft-record'
import { parsePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import { processDeviceStore } from '../../device-store/device-store'
import {
  persistNotificationReplyDraft,
  notificationReplyPaneDraftScope
} from './notification-reply-draft-handoff'
import { resolveHostIdForFingerprint } from '../payload-identity/push-host-fingerprint'
import { readOrcaPushPayload } from '../payload-identity/push-payload'
import { readNativeNotificationData } from '../payload-identity/native-notification-data'
import { loadHosts } from '../../host-catalog/host-store'
import { sendNotificationReply } from './notification-reply-delivery'
import { completeNativeReply } from './notification-reply-native'
import { showAndroidReplySent } from './android-reply-presentation'
import { translate } from '../../i18n/mobile-i18n'
import {
  mobileBotGroupDraftKey,
  mobileBotGroupDraftWorkspaceId
} from '../../bots/use-mobile-bot-group-draft'
import { botItemCommentDraftKey } from '../../bots/items/bot-item-comment-drafts'

const PREFIX = 'orca:notificationReply:'
const recordQueues = new Map<string, Promise<void>>()
const active = new Map<string, Promise<boolean>>()

export async function restoreNotificationReplyDraft(data: unknown): Promise<void> {
  if (
    data &&
    typeof data === 'object' &&
    'replyDraftId' in data &&
    typeof data.replyDraftId === 'string'
  ) {
    await runKeyedSerializedOperation(recordQueues, data.replyDraftId, () =>
      restoreDraft(data)
    ).catch((error: unknown) => {
      console.warn('[notification-reply] recovery draft unavailable', error)
    })
  }
}

async function restoreDraft(data: unknown): Promise<void> {
  if (
    !data ||
    typeof data !== 'object' ||
    !('replyDraftId' in data) ||
    typeof data.replyDraftId !== 'string'
  ) {
    return
  }
  const raw = await notificationReplyRecords.getItem(PREFIX + data.replyDraftId)
  if (!raw) {
    return
  }
  const saved = readNotificationReplyDraftRecord(raw)
  if (!saved) {
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
  const groupId = payload.replyTarget?.type === 'group' ? payload.replyTarget.groupId : null
  const workspace = groupId ? mobileBotGroupDraftWorkspaceId(groupId) : payload.worktreeId
  const draftKey =
    payload.replyTarget?.type === 'bot-item'
      ? botItemCommentDraftKey(hostId, payload.replyTarget.itemUid)
      : groupId
        ? mobileBotGroupDraftKey(hostId, groupId, groupId)
        : pane
          ? notificationReplyPaneDraftScope(hostId, workspace, `${pane.tabId}:${pane.leafId}`)
          : null
  if (!draftKey) {
    return
  }
  const store = processDeviceStore()
  if ((await store.open()) !== 'ready') {
    return
  }
  const persisted = await persistNotificationReplyDraft(
    {
      read: (table, keys) => store.read(hostId, table, keys),
      write: (table, ops) => store.write(hostId, table, ops)
    },
    draftKey,
    data.replyDraftId,
    text
  )
  if (!persisted) {
    return
  }
  await notificationReplyRecords.setItem(
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
  const id = notificationReplyResponseId(response)
  const pending = active.get(id)
  if (pending) {
    return pending.finally(async () => {
      if (await notificationReplyRecords.getItem(PREFIX + id)) {
        await completeNativeReply(response)
      }
    })
  }
  const result = runKeyedSerializedOperation(recordQueues, id, () =>
    deliver(response, data, text, id)
  ).finally(async () => {
    active.delete(id)
    if (await notificationReplyRecords.getItem(PREFIX + id)) {
      await completeNativeReply(response)
    }
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
  if (await notificationReplyRecords.getItem(key)) {
    return true
  }
  await notificationReplyRecords.setItem(
    key,
    JSON.stringify({ text, state: 'sending', data, at: Date.now() })
  )
  try {
    await sendNotificationReply(data, text, `notification-reply-${id}`)
  } catch (error) {
    console.warn('[notification-reply] delivery failed', error)
    const failed = {
      text,
      state: 'failure-pending',
      data,
      at: Date.now(),
      reason: error instanceof NotificationReplyFailure ? error.reason : 'unreachable'
    }
    await notificationReplyRecords.setItem(key, JSON.stringify(failed))
    await finishReplyFailure(key, id, failed)
    return true
  }
  await notificationReplyRecords.setItem(key, JSON.stringify({ state: 'sent', at: Date.now() }))
  await showAndroidReplySent(response).catch(() => {})
  await Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(
    () => {}
  )
  return true
}

async function showReplyFailure(data: unknown, id: string, reason: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: `notification-reply-failure-${id}`,
    content: {
      title: translate('notifications.reply.failed', 'Reply not sent'),
      body: notificationReplyFailureMessage(reason),
      data: { ...readOrcaPushPayload(data), replyDraftId: id },
      sound: 'default'
    },
    trigger: null
  })
}

async function finishReplyFailure(
  key: string,
  id: string,
  saved: { data: unknown; reason: string }
): Promise<void> {
  await showReplyFailure(saved.data, id, saved.reason)
  await notificationReplyRecords.setItem(key, JSON.stringify({ ...saved, state: 'failed' }))
}

export async function recoverInterruptedNotificationReplies(): Promise<void> {
  const keys = (await notificationReplyRecords.getAllKeys()).filter((key) => key.startsWith(PREFIX))
  for (const key of keys) {
    const id = key.slice(PREFIX.length)
    await runKeyedSerializedOperation(recordQueues, id, async () => {
      const raw = await notificationReplyRecords.getItem(key)
      if (!raw) {
        return
      }
      let saved: unknown
      try {
        saved = JSON.parse(raw)
      } catch {
        return
      }
      if (!saved || typeof saved !== 'object' || !('state' in saved)) {
        return
      }
      if (saved.state === 'sending' && 'data' in saved && 'text' in saved) {
        const pending = {
          ...saved,
          state: 'failure-pending',
          at: Date.now(),
          reason: 'unconfirmed'
        }
        await notificationReplyRecords.setItem(key, JSON.stringify(pending))
        await finishReplyFailure(key, id, pending)
      } else if (
        saved.state === 'failure-pending' &&
        'data' in saved &&
        'reason' in saved &&
        typeof saved.reason === 'string'
      ) {
        await finishReplyFailure(key, id, { ...saved, data: saved.data, reason: saved.reason })
      } else if (
        (saved.state === 'sent' || ('restored' in saved && saved.restored === true)) &&
        'at' in saved &&
        typeof saved.at === 'number' &&
        Date.now() - saved.at > 7 * 24 * 60 * 60 * 1000
      ) {
        await notificationReplyRecords.removeItem(key)
      }
    }).catch((error: unknown) => {
      console.warn('[notification-reply] recovery record unavailable', error)
    })
  }
}
