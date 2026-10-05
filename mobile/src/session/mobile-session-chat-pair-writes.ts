import {
  createChatPairPendingWrites,
  type ChatPairPendingWrites,
  type ChatPairWriteReply,
  type ChatPairWriteRequest
} from '../../../src/shared/chat-pair-pending'
import type { RuntimeSessionTabChatViewWrite } from '../../../src/shared/runtime-session-contracts'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { structuredSessionRandomUuid } from './structured-session-operation-id'

export type MobileChatPairKey = { hostId: string; worktreeId: string; parentTabId: string }

/** What one mounted session route lends the process-wide writer for its host and worktree. */
export type MobileChatPairRouteBinding = {
  /** Whether the route has accepted a snapshot for this worktree; before that its rows are empty. */
  ready: () => boolean
  readHostPair: (parentTabId: string) => TerminalChatPair | null
  send: (
    parentTabId: string,
    request: ChatPairWriteRequest,
    write: RuntimeSessionTabChatViewWrite
  ) => Promise<ChatPairWriteReply>
  reportFailure: (parentTabId: string, error: unknown) => void
}

export class MobileChatPairRouteGoneError extends Error {
  constructor() {
    super('The session screen for this workspace is closed.')
    this.name = 'MobileChatPairRouteGoneError'
  }
}

// Why a list: a pushed route (history -> resume) can mount a second screen for the same worktree.
const bindings = new Map<string, MobileChatPairRouteBinding[]>()
let writes: ChatPairPendingWrites<MobileChatPairKey> | null = null
// Why module-level: one overlay copy that every mounted route for the worktree renders.
let shownPairs: ReadonlyMap<string, TerminalChatPair> = new Map()
const overlayListeners = new Set<() => void>()

function scopeId(hostId: string, worktreeId: string): string {
  return `${hostId}\0${worktreeId}`
}

export function mobileChatPairKeyId(key: MobileChatPairKey): string {
  return `${scopeId(key.hostId, key.worktreeId)}\0${key.parentTabId}`
}

/** The most recently mounted route for the key's worktree: the one on top of the stack. */
function topBinding(key: MobileChatPairKey): MobileChatPairRouteBinding | undefined {
  const routes = bindings.get(scopeId(key.hostId, key.worktreeId))
  return routes?.at(-1)
}

/** Reads and sends go through the topmost route that holds rows, so a just-pushed one cannot read "gone". */
function bindingFor(key: MobileChatPairKey): MobileChatPairRouteBinding | undefined {
  const routes = bindings.get(scopeId(key.hostId, key.worktreeId)) ?? []
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index]
    if (route?.ready()) {
      return route
    }
  }
  return topBinding(key)
}

function showPending(key: MobileChatPairKey, pair: TerminalChatPair | null): void {
  const id = mobileChatPairKeyId(key)
  if (!pair && !shownPairs.has(id)) {
    return
  }
  const next = new Map(shownPairs)
  if (pair) {
    next.set(id, pair)
  } else {
    next.delete(id)
  }
  shownPairs = next
  for (const listener of overlayListeners) {
    listener()
  }
}

export function subscribeMobileChatPairOverlay(listener: () => void): () => void {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

/** Pending pairs shown over the host pair, by `mobileChatPairKeyId`. */
export function readMobileChatPairOverlay(): ReadonlyMap<string, TerminalChatPair> {
  return shownPairs
}

/** The write may have reached the host, so the same sequence number is resent once. */
export function isMobileChatPairDeliveryUnknown(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}

/** One writer per JS context: the host fences by writer id, and the sequence never resets. */
export function getMobileChatPairWrites(): ChatPairPendingWrites<MobileChatPairKey> {
  writes ??= createChatPairPendingWrites<MobileChatPairKey>({
    writerId: structuredSessionRandomUuid(),
    keyId: mobileChatPairKeyId,
    readHostPair: (key) => bindingFor(key)?.readHostPair(key.parentTabId) ?? null,
    send: (key, request, write) => {
      const binding = bindingFor(key)
      return binding
        ? binding.send(key.parentTabId, request, write)
        : Promise.reject(new MobileChatPairRouteGoneError())
    },
    isDeliveryUnknown: isMobileChatPairDeliveryUnknown,
    showPending,
    // Why the top route: the failure toast belongs on the screen the user is looking at.
    reportFailure: (key, error) => topBinding(key)?.reportFailure(key.parentTabId, error),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the only handles passed back are the ones setTimer returned.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  return writes
}

export function mobileChatPairKeysInScope(hostId: string, worktreeId: string): MobileChatPairKey[] {
  return getMobileChatPairWrites()
    .pendingKeys()
    .filter((key) => key.hostId === hostId && key.worktreeId === worktreeId)
}

/**
 * Lends a route's reads and sends to the writer. The unbind removes only this route's binding and
 * drops the worktree's pending writes once no route for it is left.
 */
export function bindMobileChatPairRoute(
  hostId: string,
  worktreeId: string,
  binding: MobileChatPairRouteBinding
): () => void {
  const id = scopeId(hostId, worktreeId)
  bindings.set(id, [...(bindings.get(id) ?? []), binding])
  return () => {
    const remaining = (bindings.get(id) ?? []).filter((candidate) => candidate !== binding)
    if (remaining.length > 0) {
      bindings.set(id, remaining)
      return
    }
    bindings.delete(id)
    for (const key of mobileChatPairKeysInScope(hostId, worktreeId)) {
      getMobileChatPairWrites().drop(key)
    }
  }
}
