import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  isWatchPromptAction,
  type WatchPromptAction,
  type WatchPromptReply
} from '../../../../src/shared/notifications/watch-prompt-reply'
import { resolveHostIdForFingerprint } from '../payload-identity/push-host-fingerprint'
import { readOrcaPushPayload } from '../payload-identity/push-payload'

const STORAGE_KEY = 'orca.watch-prompt-pending'

export type PendingWatchPrompt = {
  readonly hostId: string
  readonly worktreeId: string
  readonly paneKey: string
  readonly reply: WatchPromptReply
  readonly action: WatchPromptAction
}

type WatchPromptHandler = (pending: PendingWatchPrompt) => Promise<void>

let handler: WatchPromptHandler | null = null
const inflight = new Set<string>()

export function pendingWatchPromptFromNotification(
  action: string,
  data: unknown,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[]
): PendingWatchPrompt | null {
  if (!isWatchPromptAction(action)) {
    return null
  }
  const payload = readOrcaPushPayload(data)
  if (!payload?.promptReply || !payload.paneKey || !payload.worktreeId) {
    return null
  }
  const hostId = resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
  if (!hostId) {
    return null
  }
  return {
    hostId,
    worktreeId: payload.worktreeId,
    paneKey: payload.paneKey,
    reply: payload.promptReply,
    action
  }
}

export async function rememberWatchPrompt(pending: PendingWatchPrompt): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
  dispatch(pending)
}

export async function forgetWatchPrompt(pending: PendingWatchPrompt): Promise<void> {
  const stored = parseStored(await AsyncStorage.getItem(STORAGE_KEY))
  if (stored && watchPromptKey(stored) === watchPromptKey(pending)) {
    await AsyncStorage.removeItem(STORAGE_KEY)
  }
}

export function subscribeWatchPrompts(next: WatchPromptHandler): () => void {
  handler = next
  void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
    if (handler !== next) {
      return
    }
    const pending = parseStored(raw)
    if (pending) {
      dispatch(pending)
    }
  })
  return () => {
    if (handler === next) {
      handler = null
    }
  }
}

export function resetWatchPromptsForTests(): void {
  handler = null
  inflight.clear()
}

function dispatch(pending: PendingWatchPrompt): void {
  const key = watchPromptKey(pending)
  if (!handler || inflight.has(key)) {
    return
  }
  inflight.add(key)
  void handler(pending).finally(() => {
    inflight.delete(key)
  })
}

function watchPromptKey(pending: PendingWatchPrompt): string {
  return JSON.stringify([
    pending.hostId,
    pending.worktreeId,
    pending.paneKey,
    pending.action,
    pending.reply.allow,
    pending.reply.deny
  ])
}

function parseStored(raw: string | null): PendingWatchPrompt | null {
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  if (
    !('hostId' in parsed) ||
    !('worktreeId' in parsed) ||
    !('paneKey' in parsed) ||
    !('action' in parsed) ||
    !('reply' in parsed) ||
    typeof parsed.hostId !== 'string' ||
    typeof parsed.worktreeId !== 'string' ||
    typeof parsed.paneKey !== 'string' ||
    typeof parsed.action !== 'string' ||
    !isWatchPromptAction(parsed.action) ||
    !isReply(parsed.reply)
  ) {
    return null
  }
  return {
    hostId: parsed.hostId,
    worktreeId: parsed.worktreeId,
    paneKey: parsed.paneKey,
    action: parsed.action,
    reply: parsed.reply
  }
}

function isReply(value: unknown): value is WatchPromptReply {
  if (!value || typeof value !== 'object' || !('allow' in value) || !('deny' in value)) {
    return false
  }
  return (
    typeof value.allow === 'string' &&
    value.allow.length > 0 &&
    typeof value.deny === 'string' &&
    value.deny.length > 0
  )
}
