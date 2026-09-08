import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_PENDING_TEXT_MAX_CHARACTERS
} from '../../../src/shared/mobile-web/native-chat-operation-contract'

export const MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT =
  MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT
export const MOBILE_SESSION_CHAT_PENDING_TEXT_MAX_CHARACTERS =
  MOBILE_WEB_NATIVE_CHAT_PENDING_TEXT_MAX_CHARACTERS

export type MobileSessionChatPendingDelivery = {
  text: string
  expectedOccurrence: number
}

export type MobileSessionChatPendingDeliveryScope = {
  hostIdentity: string
  buildIdentity: string
  workspaceIdentity: string
  tabIdentity: string
  providerSessionIdentity: string
}

const STORAGE_KEY_PREFIX = 'orca:mobile-session-chat-pending-deliveries:v1:'

export async function loadMobileSessionChatPendingDeliveries(
  scope: MobileSessionChatPendingDeliveryScope
): Promise<MobileSessionChatPendingDelivery[]> {
  const value = await AsyncStorage.getItem(storageKey(scope))
  if (typeof value !== 'string') {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.slice(0, MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT).flatMap(parsePendingDelivery)
      : []
  } catch {
    return []
  }
}

export async function saveMobileSessionChatPendingDeliveries(
  scope: MobileSessionChatPendingDeliveryScope,
  deliveries: readonly MobileSessionChatPendingDelivery[]
): Promise<void> {
  const key = storageKey(scope)
  if (deliveries.length === 0) {
    await AsyncStorage.removeItem(key)
    return
  }
  const bounded = deliveries
    .slice(0, MOBILE_SESSION_CHAT_PENDING_DELIVERY_LIMIT)
    .flatMap(parsePendingDelivery)
  if (bounded.length === 0) {
    await AsyncStorage.removeItem(key)
    return
  }
  await AsyncStorage.setItem(key, JSON.stringify(bounded))
}

function parsePendingDelivery(value: unknown): MobileSessionChatPendingDelivery[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    value.text.length === 0 ||
    value.text.length > MOBILE_SESSION_CHAT_PENDING_TEXT_MAX_CHARACTERS ||
    !('expectedOccurrence' in value) ||
    typeof value.expectedOccurrence !== 'number' ||
    !Number.isSafeInteger(value.expectedOccurrence) ||
    value.expectedOccurrence < 1
  ) {
    return []
  }
  return [{ text: value.text, expectedOccurrence: value.expectedOccurrence }]
}

function storageKey(scope: MobileSessionChatPendingDeliveryScope): string {
  return `${STORAGE_KEY_PREFIX}${digest(scope.hostIdentity)}:${digest(
    scope.buildIdentity
  )}:${digest(scope.workspaceIdentity)}:${digest(scope.tabIdentity)}:${digest(
    scope.providerSessionIdentity
  )}`
}

function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
