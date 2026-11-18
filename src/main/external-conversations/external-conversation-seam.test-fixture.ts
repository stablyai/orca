import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { ConversationChatHost } from './external-conversation-chat'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentPaneChange } from '../agent-hooks/observations/agent-transition-detector'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { DeliveryReceipts } from './external-conversation-delivery-receipts'
import {
  ExternalConversationSeam,
  type ExternalConversationSeamDeps
} from './external-conversation-seam'
import { fakeLinkStore } from './external-conversation.test-fixture'

export function harness(
  records = fakeLinkStore(),
  db = new OrchestrationDb(':memory:'),
  extra: Pick<ExternalConversationSeamDeps, 'nameChannel' | 'promptsAudience'> = {}
) {
  const removed = new Set<(worktreeId: string) => void>()
  const hookRows = new Map<string, AgentStatusIpcPayload>()
  const paneListeners = new Set<(change: AgentPaneChange) => void>()
  const linked = { count: 0 }
  const seam = (): ExternalConversationSeam =>
    new ExternalConversationSeam({
      store: records.store,
      receipts: new DeliveryReceipts(() => db),
      onWorkspaceRemoved: (listener) => {
        removed.add(listener)
        return () => removed.delete(listener)
      },
      readHookRow: (paneKey) => hookRows.get(paneKey) ?? null,
      onAgentPaneChange: (listener) => {
        paneListeners.add(listener)
        return () => paneListeners.delete(listener)
      },
      onLinked: () => {
        linked.count += 1
      },
      ...extra
    })
  const removeWorkspace = (worktreeId: string): void =>
    removed.forEach((listener) => listener(worktreeId))
  return {
    ...records,
    seam: seam(),
    restart: seam,
    db,
    /** Times the seam reported a new or moved link. */
    linked,
    removed,
    removeWorkspace,
    /** The hook store's newest row per pane, as `readHookRow` reads it. */
    hookRows,
    paneListeners,
    paneChange: (change: AgentPaneChange): void =>
      paneListeners.forEach((listener) => listener(change))
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A native-chat host slot a test installs and replaces, as Orca does. */
export function installedChats(initial: StructuredAgentSessionHost | null) {
  let installed = initial
  const listeners = new Set<() => void>()
  const chats: ConversationChatHost = {
    current: () => installed,
    ensure: async () => installed,
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    chats,
    install: (next: StructuredAgentSessionHost | null) => {
      installed = next
      listeners.forEach((listener) => listener())
    }
  }
}

/** Until the chat's agent finishes starting: a Stop before then ends the start, not a turn. */
export async function agentReady(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<void> {
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().sessions.get(sessionId)?.child?.phase).toBe('ready')
  )
}
