import type { AgentRunAccountProvider } from '../../shared/agent-run-account'
import type { CodexPaneAccountRecord } from '../codex/codex-pane-account-registry'
import {
  keptConversationKey,
  type KeptAgentConversations,
  type KeptConversation
} from './kept-agent-conversations'

export type KeptConversationLookup = Pick<KeptAgentConversations, 'get' | 'keep' | 'releaseCarried'>

function keptEntry(
  kept: KeptConversationLookup,
  provider: AgentRunAccountProvider,
  sessionId: string | null | undefined
): KeptConversation | null {
  const entry = sessionId ? kept.get(provider, sessionId) : null
  return entry && entry !== 'unavailable' ? entry : null
}

/** The account a conversation is kept on; undefined = not kept, or the index cannot say. */
export function keptConversationAccount(
  kept: KeptConversationLookup,
  provider: AgentRunAccountProvider,
  sessionId: string | null
): string | null | undefined {
  return keptEntry(kept, provider, sessionId)?.accountId
}

/** Carries a predecessor's keep to the session after it in the same agent, on the same account. */
function carryKeep(args: {
  kept: KeptConversationLookup
  provider: AgentRunAccountProvider
  previousSessionId: string | null | undefined
  sessionId: string | null
  accountId: string | null | undefined
  transcriptPath: string | undefined
  now: number
}): void {
  const { kept, provider, sessionId, accountId, previousSessionId } = args
  if (!sessionId || accountId === undefined || !previousSessionId) {
    return
  }
  const previous =
    sessionId === previousSessionId ? null : keptEntry(kept, provider, previousSessionId)
  if (!previous || previous.accountId !== accountId) {
    return
  }
  const current = kept.get(provider, sessionId)
  if (current === 'unavailable' || current?.accountId === accountId) {
    return
  }
  kept.keep(provider, sessionId, {
    lane: 'host',
    accountId,
    keptAt: args.now,
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
    // Why the root: un-keeping any session of the agent then releases all of them.
    keptVia: previous.keptVia ?? keptConversationKey(provider, previousSessionId)
  })
}

/** A Claude session carries its predecessor's keep only when it provably runs on that account. */
export function adoptClaudeSession(args: {
  kept: KeptConversationLookup
  previousSessionId: string | null | undefined
  sessionId: string | null
  accountId: string | null | undefined
  transcriptPath: string | undefined
  now: number
}): void {
  carryKeep({ ...args, provider: 'claude' })
}

/** A carried Claude keep the statusline proves runs on another account is dropped; a person's own never is. */
export function dropMisplacedClaudeKeep(
  kept: KeptConversationLookup,
  sessionId: string | null,
  accountId: string | null
): void {
  const entry = keptEntry(kept, 'claude', sessionId)
  if (sessionId && entry?.keptVia && entry.accountId !== accountId) {
    kept.releaseCarried('claude', sessionId, entry.keptAt)
  }
}

/** A kept Codex pane's home is fixed at spawn, so every session it reports runs there. */
export function adoptCodexSession(args: {
  kept: KeptConversationLookup
  record: CodexPaneAccountRecord | null
  previousSessionId: string | null | undefined
  sessionId: string | null
  transcriptPath: string | undefined
  now: number
}): void {
  const { kept, record, sessionId } = args
  if (!record?.kept || record.selectionKey !== 'host' || !sessionId) {
    return
  }
  const current = kept.get('codex', sessionId)
  if (current === 'unavailable' || current?.accountId === record.accountId) {
    return
  }
  const previous = keptEntry(kept, 'codex', args.previousSessionId)
  const keptVia =
    previous && args.previousSessionId && previous.accountId === record.accountId
      ? (previous.keptVia ?? keptConversationKey('codex', args.previousSessionId))
      : undefined
  kept.keep('codex', sessionId, {
    lane: 'host',
    accountId: record.accountId,
    keptAt: args.now,
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
    ...(keptVia ? { keptVia } : {})
  })
}
