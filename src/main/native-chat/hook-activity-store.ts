import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { mergeNativeChatMessages } from '../../shared/native-chat-merge'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'

type ActivityListener = (message: NativeChatMessage) => void

export class NativeChatHookActivityStore {
  private root: string | null = null
  private readonly sessionByPane = new Map<string, { agent: AgentType; sessionId: string }>()
  private readonly activeByOperation = new Map<string, NativeChatMessage>()
  private readonly listeners = new Map<string, Set<ActivityListener>>()

  setRoot(root: string | null): void {
    this.root = null
    if (!root) {
      return
    }
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      this.root = root
    } catch (error) {
      console.warn('[native-chat] failed to prepare hook activity storage', error)
    }
  }

  reset(): void {
    this.root = null
    this.sessionByPane.clear()
    this.activeByOperation.clear()
  }

  ingest(event: AgentHookEventPayload & { receivedAt: number }): NativeChatMessage | null {
    const reportedAgent = event.payload.agentType?.trim()
    const reportedSession = event.providerSession?.id.trim()
    if (reportedAgent && reportedSession) {
      this.sessionByPane.set(event.paneKey, {
        agent: reportedAgent,
        sessionId: reportedSession
      })
    }
    if (event.isReplay || event.toolAgentId) {
      return null
    }
    const session =
      reportedAgent && reportedSession
        ? { agent: reportedAgent, sessionId: reportedSession }
        : this.sessionByPane.get(event.paneKey)
    if (session?.agent !== 'codex') {
      return null
    }
    const hookEvent = normalizeHookEventName(event.hookEventName)
    if (hookEvent !== 'pretooluse' && !hookEvent.startsWith('posttooluse')) {
      return null
    }
    const toolUseId = event.toolUseId?.trim()
    const toolName = event.payload.toolName?.trim()
    if (!session || !event.toolActivity || !toolUseId || !toolName) {
      return null
    }

    const operationKey = `${activityKey(session.agent, session.sessionId)}\0${toolUseId}`
    const previous =
      this.activeByOperation.get(operationKey) ??
      (hookEvent.startsWith('posttooluse')
        ? this.read(session.agent, session.sessionId).find(
            (message) => message.id === `hook:${toolUseId}`
          )
        : undefined)
    const previousCall = previous?.blocks.find((block) => block.type === 'tool-call')
    const completed = hookEvent.startsWith('posttooluse')
    const message: NativeChatMessage = {
      id: `hook:${toolUseId}`,
      turnId: toolUseId,
      role: 'tool',
      blocks: [
        {
          type: 'tool-call',
          name: toolName,
          input:
            event.toolActivity.input ??
            (previousCall?.type === 'tool-call' ? previousCall.input : null)
        },
        ...(completed && event.toolActivity.output !== undefined
          ? [
              {
                type: 'tool-result' as const,
                output: event.toolActivity.output,
                ...(event.toolActivity.isError ? { isError: true } : {})
              }
            ]
          : [])
      ],
      timestamp: previous?.timestamp ?? event.receivedAt,
      source: 'hook'
    }

    if (completed) {
      this.activeByOperation.delete(operationKey)
    } else {
      this.activeByOperation.set(operationKey, message)
    }
    this.append(session.agent, session.sessionId, message)
    for (const listener of this.listeners.get(activityKey(session.agent, session.sessionId)) ??
      []) {
      listener(message)
    }
    return message
  }

  read(agent: AgentType, sessionId: string): NativeChatMessage[] {
    if (!this.root) {
      return []
    }
    let content: string
    try {
      content = readFileSync(this.filePath(agent, sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      console.warn('[native-chat] failed to read hook activity', error)
      return []
    }
    const byId = new Map<string, NativeChatMessage>()
    for (const line of content.split('\n')) {
      if (!line) {
        continue
      }
      try {
        const message = JSON.parse(line) as unknown
        if (isHookActivityMessage(message)) {
          byId.set(message.id, normalizePersistedHookTurnId(message))
        }
      } catch {
        // Ignore one torn/corrupt append; later records remain readable.
      }
    }
    return [...byId.values()].sort(compareMessages)
  }

  subscribe(agent: AgentType, sessionId: string, listener: ActivityListener): () => void {
    const key = activityKey(agent, sessionId)
    const listeners = this.listeners.get(key) ?? new Set<ActivityListener>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(key)
      }
    }
  }

  private append(agent: AgentType, sessionId: string, message: NativeChatMessage): void {
    if (!this.root) {
      return
    }
    try {
      appendFileSync(this.filePath(agent, sessionId), `${JSON.stringify(message)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
    } catch (error) {
      // Hook delivery must stay fail-open: activity persistence cannot block an agent.
      console.warn('[native-chat] failed to persist hook activity', error)
    }
  }

  private filePath(agent: AgentType, sessionId: string): string {
    const hash = createHash('sha256').update(activityKey(agent, sessionId)).digest('hex')
    return join(this.root!, `${hash}.jsonl`)
  }
}

function normalizePersistedHookTurnId(message: NativeChatMessage): NativeChatMessage {
  return message.turnId === message.id && message.id.startsWith('hook:')
    ? { ...message, turnId: message.id.slice('hook:'.length) }
    : message
}

export const nativeChatHookActivityStore = new NativeChatHookActivityStore()

export function mergeNativeChatHookActivity(
  transcript: readonly NativeChatMessage[],
  activity: readonly NativeChatMessage[],
  includeAfterLatest = false
): NativeChatMessage[] {
  if (activity.length === 0) {
    return transcript.slice()
  }
  const timestamps = transcript.flatMap((message) =>
    message.timestamp == null ? [] : [message.timestamp]
  )
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : null
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : null
  const inWindow = activity.filter(
    (message) =>
      message.timestamp == null ||
      earliest == null ||
      latest == null ||
      (message.timestamp >= earliest && (includeAfterLatest || message.timestamp <= latest))
  )
  return mergeNativeChatMessages(transcript, inWindow).sort(compareMessages)
}

function activityKey(agent: AgentType, sessionId: string): string {
  return `${agent}\0${sessionId}`
}

function normalizeHookEventName(value: string | undefined): string {
  return value?.replaceAll(/[^a-z]/gi, '').toLowerCase() ?? ''
}

function compareMessages(left: NativeChatMessage, right: NativeChatMessage): number {
  return (left.timestamp ?? -1) - (right.timestamp ?? -1) || left.id.localeCompare(right.id)
}

function isHookActivityMessage(value: unknown): value is NativeChatMessage {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Partial<NativeChatMessage>
  return (
    typeof message.id === 'string' &&
    message.role === 'tool' &&
    message.source === 'hook' &&
    (message.timestamp === null || typeof message.timestamp === 'number') &&
    Array.isArray(message.blocks) &&
    message.blocks.every((block) => {
      if (!block || typeof block !== 'object') {
        return false
      }
      const candidate = block as { type?: unknown; output?: unknown }
      return (
        candidate.type === 'tool-call' ||
        (candidate.type === 'tool-result' && typeof candidate.output === 'string')
      )
    })
  )
}
