import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'

export const MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS = 4096

export type MobileSessionChatDraftScope = {
  hostIdentity: string
  buildIdentity: string
  workspaceIdentity: string
  tabIdentity: string
}

const STORAGE_KEY_PREFIX = 'orca:mobile-session-chat-draft:v1:'

export async function loadMobileSessionChatDraft(
  scope: MobileSessionChatDraftScope
): Promise<string> {
  const value = await AsyncStorage.getItem(storageKey(scope))
  return typeof value === 'string' && value.length <= MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS
    ? value
    : ''
}

export async function saveMobileSessionChatDraft(
  scope: MobileSessionChatDraftScope,
  text: string
): Promise<void> {
  const key = storageKey(scope)
  if (text.length === 0) {
    await AsyncStorage.removeItem(key)
    return
  }
  await AsyncStorage.setItem(key, text.slice(0, MOBILE_SESSION_CHAT_DRAFT_MAX_CHARACTERS))
}

function storageKey(scope: MobileSessionChatDraftScope): string {
  return `${STORAGE_KEY_PREFIX}${digest(scope.hostIdentity)}:${digest(scope.buildIdentity)}:${digest(
    scope.workspaceIdentity
  )}:${digest(scope.tabIdentity)}`
}

function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
