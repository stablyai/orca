import type { PageDeviceStore } from '../../mobile-web-shell/bridge/page-storage/page-device-store'
import { durableDraftRowKey } from '../../drafts/durable-draft-rows'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../../device-store/device-store-value-codec'
import { runKeyedSerializedOperation } from '../../../../src/shared/concurrency/keyed-serialized-operations'

type DraftStore = Pick<PageDeviceStore, 'read' | 'write'>
type ReplyDraft = { id: string; text: string }
export function notificationReplyPaneDraftScope(
  hostId: string,
  workspace: string,
  paneKey: string
): string {
  return `${hostId}\0${workspace}\0notification-pane:${paneKey}`
}

const queues = new Map<string, Promise<void>>()
const pendingKey = (scope: string) => durableDraftRowKey('notification-reply', '', scope)
const appliedKey = (id: string) => durableDraftRowKey('notification-reply-applied', '', id)

function readDrafts(raw: string | null): ReplyDraft[] {
  const value = raw === null ? null : decodeDeviceStoreValue(raw)
  return Array.isArray(value)
    ? value
        .flatMap((item: unknown) => {
          if (
            !item ||
            typeof item !== 'object' ||
            !('id' in item) ||
            !('text' in item) ||
            typeof item.id !== 'string' ||
            item.id.length !== 64 ||
            typeof item.text !== 'string'
          ) {
            return []
          }
          return [{ id: item.id, text: item.text }]
        })
        .slice(0, 32)
    : []
}

export function persistNotificationReplyDraft(
  store: DraftStore,
  scope: string,
  id: string,
  text: string
): Promise<boolean> {
  return runKeyedSerializedOperation(queues, pendingKey(scope), async () => {
    const read = await store.read('draft', [pendingKey(scope)])
    if (read.status !== 'ok') {
      return false
    }
    const existing = readDrafts(read.values[0] ?? null)
    const markers = await store.read(
      'draft',
      existing.map((draft) => appliedKey(draft.id))
    )
    if (markers.status !== 'ok') {
      return false
    }
    const kept = existing.filter((_, index) => markers.values[index] === null)
    const next = kept.some((draft) => draft.id === id) ? kept : [...kept, { id, text }]
    if (next.length > 32) {
      return false
    }
    return (
      await store.write('draft', [{ key: pendingKey(scope), value: encodeDeviceStoreValue(next) }])
    ).written
  })
}

export function restoreNotificationReplyDrafts(
  store: DraftStore,
  scope: string,
  apply: (text: string) => Promise<boolean>
): Promise<boolean> {
  return runKeyedSerializedOperation(queues, pendingKey(scope), async () => {
    const read = await store.read('draft', [pendingKey(scope)])
    if (read.status !== 'ok') {
      return false
    }
    for (const draft of readDrafts(read.values[0] ?? null)) {
      const applied = await store.read('draft', [appliedKey(draft.id)])
      if (applied.status !== 'ok') {
        return false
      }
      if (applied.values[0] !== null) {
        continue
      }
      if (!(await apply(draft.text))) {
        return false
      }
      if (
        !(
          await store.write('draft', [
            { key: appliedKey(draft.id), value: encodeDeviceStoreValue(true) }
          ])
        ).written
      ) {
        return false
      }
    }
    return true
  })
}
