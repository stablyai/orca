import { AppState } from 'react-native'
import { mobileChatDraftLifecycle } from './mobile-native-chat-draft-store'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  persistMirrored,
  readMirroredKeyOrStore,
  pendingMirroredStorageKeys
} from '../storage/mirrored-storage-keys'
import { mobileChatDraftKeyScope } from './mobile-native-chat-draft-data'
import {
  publishMobileChatDraftStorage,
  onMobileChatDraftRemoval,
  mobileChatDraftRemoving,
  removeMobileChatDraftScopes
} from './mobile-native-chat-draft-storage'

type Removal = { host: string; workspace?: string }
const sessions = new Map<string, { closed: boolean; retired: Removal[] }>()
const matches = (key: string, removal: Removal) => {
  const scope = mobileChatDraftKeyScope(key)
  return (
    scope?.[0] === removal.host &&
    (removal.workspace === undefined || scope[1] === removal.workspace)
  )
}
onMobileChatDraftRemoval((host, workspace) => {
  for (const session of sessions.values()) {
    session.retired.push({ host, workspace })
  }
})
export function nativeChatDraftSession(sessionId: string) {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { closed: false, retired: [] }
    sessions.set(sessionId, session)
  }
  const held = session
  return (key: string): void => {
    if (held.closed || held.retired.some((removal) => matches(key, removal))) {
      throw new Error('This draft session has ended')
    }
  }
}
export function closeNativeChatDraftSession(sessionId: string): void {
  const held = sessions.get(sessionId)
  if (held) {
    held.closed = true
  }
  sessions.delete(sessionId)
}
function admit(key: string): void {
  const scope = mobileChatDraftKeyScope(key)
  if (scope && mobileChatDraftRemoving(scope.join('\0'))) {
    throw new Error('Draft cleanup is still pending')
  }
}
export async function readNativeMobileChatDraft(
  key: string,
  check?: (key: string) => void
): Promise<string | null> {
  admit(key)
  check?.(key)
  const value = await readMirroredKeyOrStore(key)
  admit(key)
  check?.(key)
  return value
}
export async function writeNativeMobileChatDraft(key: string, value: string | null): Promise<void> {
  admit(key)
  return persistMirrored(key, value)
}
export function removeStoredMobileChatDrafts(host: string, workspace?: string): Promise<void> {
  return removeMobileChatDraftScopes(host, workspace, prepareNativeRemoval)
}
function prepareNativeRemoval(host: string, workspace?: string): () => Promise<void> {
  const removal = { host, workspace }
  const keys = new Set(pendingMirroredStorageKeys().filter((key) => matches(key, removal)))
  return async () => {
    const stored = await AsyncStorage.getAllKeys()
    stored.filter((key) => matches(key, removal)).forEach((key) => keys.add(key))
    const results = await Promise.allSettled([...keys].map((key) => persistMirrored(key, null)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      throw failure.reason
    }
  }
}
export function installNativeMobileChatDraftStorage(): void {
  const lifetime = AppState.addEventListener('change', (state) =>
    mobileChatDraftLifecycle(state === 'active')
  )
  publishMobileChatDraftStorage(
    {
      read: readNativeMobileChatDraft,
      write: writeNativeMobileChatDraft,
      removeWorkspace: removeStoredMobileChatDrafts,
      dispose: () => {
        mobileChatDraftLifecycle(false)
        lifetime.remove()
      }
    },
    prepareNativeRemoval
  )
}
