import type {
  ProviderTimelineAssembler,
  ProviderTimelineAssemblerDeps
} from './provider-timeline-assembler'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle,
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalToolCallItem
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import type { ProviderTimelineSink } from './provider-timeline-plan'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { backgroundTaskFallbackText } from '../../../shared/native-chat/input/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../../shared/native-chat-types'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat-types'
import { createLegacyProviderTimelineIdentityScheme } from './provider-timeline-identity'
import type { ProviderTimelineItemFamily } from './provider-timeline-identity'

export const SESSION = 'session-timeline'
export const AGENT = 'grok'
export const GENERATION = 'gen-1'
export const NAMESPACE = 'provider-session-1'

const scheme = createLegacyProviderTimelineIdentityScheme({ agent: AGENT, sessionId: SESSION })

export function providerItemId(
  family: ProviderTimelineItemFamily | 'request',
  key: string,
  options: { namespace?: string; thread?: string; generation?: string; incarnation?: number } = {}
): string {
  return agentJournalItemKey(
    family === 'request'
      ? scheme.request({
          generation: options.generation ?? GENERATION,
          key,
          incarnation: options.incarnation ?? 1
        })
      : scheme.item({
          namespace: options.namespace ?? NAMESPACE,
          family,
          key: { source: 'provider', value: key },
          thread: options.thread ?? null
        })
  )
}

export function providerTurnItemId(turnKey: string, namespace = NAMESPACE): string {
  return agentJournalItemKey(
    scheme.turn({ namespace, key: { source: 'provider', value: turnKey } })
  )
}

export function providerTurnId(turnKey: string, namespace = NAMESPACE): string {
  return scheme.turnId({ namespace, key: { source: 'provider', value: turnKey } })
}

export function runningTool(name: string): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: { name }, state: 'running' }
}

/** Include the plain-text twin before the structured background-task block. */
export function backgroundTask(
  taskId: string,
  state: NativeChatBackgroundTaskBlock['state']
): AgentJournalMessageItem {
  const block: NativeChatBackgroundTaskBlock = {
    type: 'background-task',
    taskId,
    kind: 'command',
    label: taskId,
    state
  }
  return {
    kind: 'message',
    role: 'system',
    blocks: [{ type: 'text', text: backgroundTaskFallbackText(block) }, block]
  }
}

export async function backgroundTaskState(
  rig: ProviderTimelineRig,
  item: string
): Promise<string | undefined> {
  const body = (await rig.row(providerItemId('item', item)))?.body
  const block = body?.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
  return block?.state
}

export function assistantText(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

export const pendingApproval: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Run?',
  detail: null,
  options: [{ id: 'allow', label: 'Allow' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}

export function messageText(body: AgentJournalItemBody | undefined): string | undefined {
  return body?.kind === 'message' && body.blocks[0]?.type === 'text'
    ? body.blocks[0].text
    : undefined
}

export type UnboundProviderTimelineAssembler = {
  assembler: ProviderTimelineAssembler
  bind(): Promise<void>
  drained(): Promise<void>
}

export type ProviderTimelineRig = {
  journal: AgentSessionJournal
  assembler: ProviderTimelineAssembler
  sink: ProviderTimelineSink
  eventSink: StructuredAgentSessionEventSink
  /** Drop buffered text, sweep the dead generation, then create the next child’s assembler. */
  restart(overrides?: Partial<ProviderTimelineAssemblerDeps>): Promise<ProviderTimelineAssembler>
  /** Alternate same-generation assembler; leave the original unused. */
  assemble(overrides?: Partial<ProviderTimelineAssemblerDeps>): ProviderTimelineAssembler
  rows(): Promise<AgentJournalRenderItem[]>
  reopenJournal(): Promise<AgentSessionJournal>
  row(itemId: string): Promise<AgentJournalRenderItem | undefined>
  turn(turnKey: string, namespace?: string): Promise<AgentJournalTurnLifecycle | undefined>
  turns(): Promise<AgentJournalTurnLifecycle[]>
}
