import { decodeAgentSessionQuestionAnswers } from '../../shared/agent-session-question-answer'
import { randomUUID } from 'node:crypto'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity,
  AgentJournalTurn
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type {
  StructuredMachineAgent,
  StructuredProviderConfiguration
} from '../../shared/structured-agent-provider'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { HarnessConversationDriver } from './driver'

export type MachineStructuredMessage = { body: AgentJournalMessageItem; turn?: AgentJournalTurn }

export type MachineStructuredSession = {
  agent: StructuredMachineAgent
  driver: HarnessConversationDriver
  events: StructuredAgentSessionEventSink
  fence: number
  acquisitionGeneration: string
  process: AgentSessionProcessIdentity
  providerSessionId: string
  messages: Map<string, MachineStructuredMessage>
  prompts: Map<string, { kind: 'approval' | 'question'; requestId: string }>
  activeTurn: string | null
  requestedClose: boolean
  context: AgentSessionContextSnapshot | null
  configuration: StructuredProviderConfiguration | null
  transcriptPath: string | null
}

export function machineAgent(agent: string): StructuredMachineAgent {
  if (
    agent === 'claude' ||
    agent === 'openclaude' ||
    agent === 'codex' ||
    agent === 'grok' ||
    agent === 'omp'
  ) {
    return agent
  }
  throw new Error(`unsupported structured machine agent ${agent}`)
}

export function providerSessionId(identity: AgentSessionJournalIdentity): string | null {
  const handle = identity.providerHandle
  if (handle.kind === 'claude' || handle.kind === 'acp') {
    return handle.sessionId
  }
  return null
}

export function providerHandleLink(
  identity: AgentSessionJournalIdentity,
  agent: StructuredMachineAgent,
  sessionId: string,
  fence: number,
  observedAt: number
): AgentSessionProviderHandleLink {
  return {
    linkId: `${agent}-${fence}-${randomUUID()}`.slice(0, 128),
    handle:
      agent === 'claude' || agent === 'openclaude'
        ? { provider: 'claude', sessionId, leafUuid: null }
        : { provider: 'acp', agent, sessionId },
    origin: sessionId === providerSessionId(identity) ? 'resumed' : 'created',
    mintedAtFence: fence,
    observedAt
  }
}

export function messageIdentity(
  identity: AgentSessionJournalIdentity,
  messageId: string
): AgentJournalItemIdentity {
  return identity.agent === 'claude' && identity.providerHandle.kind === 'claude'
    ? { provider: 'claude', sessionId: identity.providerHandle.sessionId, uuid: messageId }
    : {
        provider: 'legacy',
        agent: identity.agent,
        sessionId: identity.sessionId,
        recordId: messageId
      }
}

export function promptIdentity(
  identity: AgentSessionJournalIdentity,
  requestId: string
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: identity.agent,
    sessionId: identity.sessionId,
    recordId: `prompt:${requestId}`
  }
}

export function lifecycleIdentity(
  agent: StructuredMachineAgent,
  sessionId: string,
  turnId: string
): AgentJournalItemIdentity {
  return { provider: 'legacy', agent, sessionId, recordId: `turn-lifecycle:${turnId}` }
}

export function providerPrompt(body: AgentJournalMessageItem): {
  text: string
  imagePaths: string[]
} {
  const text = body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
  const imagePaths = body.blocks.flatMap((block) =>
    block.type === 'image-ref' && block.path ? [block.path] : []
  )
  if (body.blocks.some((block) => block.type === 'image-ref' && !block.path)) {
    throw new Error('remote image URLs are not supported by this provider')
  }
  return { text, imagePaths }
}

export function optionValue(
  configuration: StructuredProviderConfiguration | null,
  key: string,
  value: string
): string | boolean {
  const descriptor = configuration?.options.find((option) => option.id === key)
  return descriptor?.kind.type === 'boolean' ? value === 'true' : value
}

export function optionRecord(
  configuration: StructuredProviderConfiguration | null
): Record<string, string> {
  return Object.fromEntries(
    (configuration?.options ?? []).flatMap((option) =>
      option.kind.currentValue === undefined || option.kind.currentValue === ''
        ? []
        : [[option.id, String(option.kind.currentValue)]]
    )
  )
}

export function providerOptions(
  configuration: StructuredProviderConfiguration | null
): AgentSessionOptionsResult {
  const model = configuration?.options.find((option) => option.id === 'model')
  const effort = configuration?.options.find((option) => option.id === 'effort')
  return {
    models:
      model?.kind.type === 'select'
        ? model.kind.choices.map((choice) => ({
            id: choice.value,
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
            isDefault: choice.value === model.kind.currentValue,
            efforts:
              effort?.kind.type === 'select'
                ? effort.kind.choices.map((entry) => ({
                    value: entry.value,
                    label: entry.label,
                    ...(entry.description ? { description: entry.description } : {})
                  }))
                : []
          }))
        : [],
    current: {
      model: model?.kind.type === 'select' ? (model.kind.currentValue ?? '') : '',
      ...(effort?.kind.type === 'select' && effort.kind.currentValue
        ? { effort: effort.kind.currentValue }
        : {})
    },
    descriptors: configuration?.options ?? [],
    canCompact: configuration?.canCompact === true,
    canSteer: configuration?.canSteer === true
  }
}

export function decodeAnswers(optionId: string): Record<string, string[]> {
  const grouped = decodeAgentSessionQuestionAnswers(optionId)
  if (grouped) {
    return Object.fromEntries(
      grouped.map((answer) => [
        answer.questionId,
        [...answer.optionIds, ...(answer.other ? [answer.other] : [])]
      ])
    )
  }
  if (!optionId.startsWith('answers:')) {
    return { answers: [optionId] }
  }
  const parsed = JSON.parse(optionId.slice('answers:'.length)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid answers')
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : []
    ])
  )
}

export async function processIdentity(
  hostId: string,
  pid: number,
  spawnToken: string,
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  let processStartTimeMs: number | null = null
  for (let attempt = 0; attempt < 3 && processStartTimeMs === null; attempt += 1) {
    processStartTimeMs = await readStartTime(pid)
  }
  if (processStartTimeMs === null) {
    throw new Error(`provider start time for pid ${pid} is unavailable`)
  }
  return { hostId, pid, processStartTimeMs, spawnToken }
}

export async function waitForProcessExit(
  process: AgentSessionProcessIdentity,
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<boolean> {
  const deadline = Date.now() + 3_000
  do {
    const start = await readStartTime(process.pid)
    if (start === null || start !== process.processStartTimeMs) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  return false
}

export function requiredEvents(
  events: StructuredAgentSessionEventSink | undefined
): StructuredAgentSessionEventSink {
  if (!events) {
    throw new Error('structured provider requires an event sink')
  }
  return events
}
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
