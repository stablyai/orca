// Chats that wait on one approval or question, for fixtures: their readers answer from memory, with no host.
import { botHostTarget } from '@/lib/bot-hosts'
import {
  getOrCreateStructuredReadOwner,
  retireStructuredAgentSessionReadOwner,
  structuredReadOwnerKey
} from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import type {
  StructuredAgentSessionReadOwner,
  StructuredAgentSessionReadSnapshot
} from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-contract'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type FixturePrompt =
  | { kind: 'question'; question: string }
  | { kind: 'approval'; title: string; detail: string }

function promptItem(sessionId: string, prompt: FixturePrompt): AgentJournalRenderItem {
  const body =
    prompt.kind === 'question'
      ? {
          kind: 'question',
          question: prompt.question,
          options: [],
          resolution: { state: 'pending' }
        }
      : {
          kind: 'approval',
          title: prompt.title,
          detail: prompt.detail,
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' }
          ],
          resolution: { state: 'pending' }
        }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Needs you reads only the prompt body.
  return {
    itemId: `${sessionId}:prompt`,
    revision: 1,
    sequence: 1,
    observedAt: 0,
    body
  } as unknown as AgentJournalRenderItem
}

/**
 * Registers a reader for each chat on this computer, holding its one pending prompt; the returned
 * call swaps a chat's prompt, as a host's update would.
 */
export function stubSessionPrompts(
  prompts: Record<string, FixturePrompt>
): (sessionId: string, prompt: FixturePrompt) => void {
  const swaps = new Map<string, (prompt: FixturePrompt) => void>()
  for (const [sessionId, first] of Object.entries(prompts)) {
    const snapshot = (prompt: FixturePrompt): StructuredAgentSessionReadSnapshot => ({
      state: {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        currentRequests: [promptItem(sessionId, prompt)]
      },
      loadingOlder: false,
      olderHistoryGeneration: 0,
      initialHistoryAutoLoad: false,
      current: true
    })
    let current = snapshot(first)
    const listeners = new Set<() => void>()
    const none = (): (() => void) => () => {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Needs you row only reads and subscribes.
    const owner = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      subscribeCommandsChanged: none,
      activate: none,
      retainHistory: none,
      trimHistory: () => {},
      dispose: () => {},
      loadOlder: async () => ({ status: 'empty' }),
      admit: async () => {},
      trackSend: () => ({ issue: () => {}, settle: () => {} }),
      publishCreated: () => {}
    } as unknown as StructuredAgentSessionReadOwner
    const target = botHostTarget('local')
    // A reader an earlier fixture left would answer instead.
    retireStructuredAgentSessionReadOwner(sessionId, target)
    getOrCreateStructuredReadOwner(structuredReadOwnerKey(sessionId, target), () => owner)
    swaps.set(sessionId, (prompt) => {
      current = snapshot(prompt)
      for (const listener of listeners) {
        listener()
      }
    })
  }
  return (sessionId, prompt) => swaps.get(sessionId)?.(prompt)
}
