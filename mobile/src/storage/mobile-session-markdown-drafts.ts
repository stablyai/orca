import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import {
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../src/shared/mobile-markdown-document'

export type MobileSessionMarkdownDraft = {
  content: string
  baseVersion: string
}

export type MobileSessionMarkdownDraftScope = {
  hostIdentity: string
  buildIdentity: string
  workspaceIdentity: string
  tabIdentity: string
  relativePath: string
}

const STORAGE_KEY_PREFIX = 'orca:mobile-session-markdown-draft:v1:'
const BASE_VERSION_MAX_CHARACTERS = 512

export async function loadMobileSessionMarkdownDraft(
  scope: MobileSessionMarkdownDraftScope
): Promise<MobileSessionMarkdownDraft | null> {
  const value = await AsyncStorage.getItem(storageKey(scope))
  if (typeof value !== 'string') {
    return null
  }
  try {
    return parseDraft(JSON.parse(value))
  } catch {
    return null
  }
}

export async function saveMobileSessionMarkdownDraft(
  scope: MobileSessionMarkdownDraftScope,
  draft: MobileSessionMarkdownDraft | null
): Promise<void> {
  const key = storageKey(scope)
  if (!draft) {
    await AsyncStorage.removeItem(key)
    return
  }
  const parsed = parseDraft(draft)
  if (!parsed) {
    throw new Error('invalid_markdown_draft')
  }
  await AsyncStorage.setItem(key, JSON.stringify(parsed))
}

function parseDraft(value: unknown): MobileSessionMarkdownDraft | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('content' in value) ||
    typeof value.content !== 'string' ||
    isMarkdownContentByteLengthOverLimit(value.content, MOBILE_MARKDOWN_EDIT_MAX_BYTES) ||
    !('baseVersion' in value) ||
    typeof value.baseVersion !== 'string' ||
    value.baseVersion.length === 0 ||
    value.baseVersion.length > BASE_VERSION_MAX_CHARACTERS
  ) {
    return null
  }
  return { content: value.content, baseVersion: value.baseVersion }
}

function storageKey(scope: MobileSessionMarkdownDraftScope): string {
  return `${STORAGE_KEY_PREFIX}${digest(scope.hostIdentity)}:${digest(
    scope.buildIdentity
  )}:${digest(scope.workspaceIdentity)}:${digest(scope.tabIdentity)}:${digest(scope.relativePath)}`
}

function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
