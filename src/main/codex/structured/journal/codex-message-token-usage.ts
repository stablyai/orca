import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import { readCodexContextUsage, readCodexTokenUsage } from './codex-context-usage'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { MAX_CODEX_DETAIL_ENTRIES } from './codex-structured-journal-limits'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'

type Response = { identity: AgentJournalItemIdentity; bytes: number; ambiguous: boolean }

/** One request can emit several messages; never repeat its full charge on each of them. */
export class CodexMessageTokenUsage {
  private readonly responses = new Map<string, Response>()

  remember(
    { threadId }: { threadId: string },
    turnId: string | null,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    source: 'live' | 'history'
  ): void {
    if (source !== 'live' || !turnId || body.kind !== 'message' || body.role !== 'assistant') {
      return
    }
    const key = JSON.stringify([threadId, turnId])
    const before = this.responses.get(key)
    this.responses.set(key, {
      identity,
      bytes: estimateStructuredAgentSessionItemBytes(identity, body),
      ambiguous:
        before !== undefined &&
        (before.ambiguous || agentJournalItemKey(before.identity) !== agentJournalItemKey(identity))
    })
    while (this.responses.size > MAX_CODEX_DETAIL_ENTRIES) {
      this.responses.delete(this.responses.keys().next().value!)
    }
  }

  record(
    sink: StructuredAgentSessionEventSink,
    threadId: string,
    turnId: string | null,
    params: unknown,
    capturedAt: number
  ) {
    const key = JSON.stringify([threadId, turnId])
    const response = this.responses.get(key)
    const usage = readCodexTokenUsage(readRecord(readRecord(params).tokenUsage).last)
    if (!response || !usage || !sink.tryReviseResolvedItem) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (response.ambiguous) {
      this.responses.delete(key)
      return CODEX_JOURNAL_ADMITTED
    }
    const facts = readCodexContextUsage(params, capturedAt)
    const used = facts?.used
    const usageContext =
      used?.kind === 'report' ? { used: { ...used, totalUsage: undefined } } : undefined
    const annotation = { usage, ...(usageContext ? { usageContext } : {}) }
    const admission = sink.tryReviseResolvedItem(
      response.bytes + Buffer.byteLength(JSON.stringify(annotation), 'utf8') + 512,
      { kind: 'message-usage', identity: response.identity, ...annotation },
      { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    if (!admission.accepted) {
      return admission
    }
    const published = sink.tryPublish
      ? sink.tryPublish({ lifecycle: true })
      : (sink.publish({ lifecycle: true }), CODEX_JOURNAL_ADMITTED)
    if (published.accepted) {
      this.responses.delete(key)
    }
    return published
  }

  clear(): void {
    this.responses.clear()
  }
}
