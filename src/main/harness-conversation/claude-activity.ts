import {
  EMPTY_AGENT_SESSION_CONTEXT,
  type AgentSessionContextSnapshot
} from '../../shared/agent-session-context'
import { claudeRecord, claudeText } from '../claude/claude-structured-item-translation'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSubagentSnapshot } from '../../shared/agent-status-types'
import type { HarnessConversationDriverSink } from './driver'

export class ClaudeConversationActivity {
  private readonly subagents = new Map<string, AgentSubagentSnapshot>()
  private currentModel: string | null = null
  private currentEffort: string | null = null
  private fastMode: boolean | null = null
  private usedTokens: number | null = null
  private maxTokens: number | null = null

  context: AgentSessionContextSnapshot = EMPTY_AGENT_SESSION_CONTEXT

  constructor(
    private readonly sink?: Pick<HarnessConversationDriverSink, 'setContext' | 'setSubagents'>
  ) {}

  setInitialFastMode(state: string | undefined): void {
    this.fastMode = state === undefined ? null : state === 'on'
    this.publishContext()
  }

  setModel(model: string): void {
    this.currentModel = model
    this.publishContext()
  }

  setEffort(effort: string): void {
    this.currentEffort = effort
    this.publishContext()
  }

  setTranscriptMetadata(metadata: { model?: string; effort?: string }): void {
    this.currentModel = metadata.model ?? this.currentModel
    this.currentEffort = metadata.effort ?? this.currentEffort
    this.publishContext()
  }

  observe(message: SDKMessage): void {
    this.observeContext(message as unknown as Record<string, unknown>)
    if (message.type === 'system' && message.subtype === 'task_started') {
      this.updateTaskStarted(message)
    } else if (message.type === 'system' && message.subtype === 'task_progress') {
      this.updateTaskProgress(message)
    } else if (message.type === 'system' && message.subtype === 'task_updated') {
      this.updateTaskStatus(message.task_id, message.patch.status, message.patch.description)
    } else if (message.type === 'system' && message.subtype === 'task_notification') {
      this.updateTaskStatus(message.task_id, message.status)
    }
  }

  observeContext(frame: Record<string, unknown>): void {
    if (frame.type === 'system' && frame.subtype === 'init') {
      this.currentModel = claudeText(frame.model) ?? this.currentModel
      this.fastMode =
        typeof frame.fast_mode_state === 'string' ? frame.fast_mode_state === 'on' : null
    } else if (frame.type === 'assistant' && frame.parent_tool_use_id == null) {
      const message = claudeRecord(frame.message)
      const usage = claudeRecord(message?.usage)
      this.currentModel = claudeText(message?.model) ?? this.currentModel
      this.currentEffort = claudeText(frame.effort) ?? this.currentEffort
      if (usage && typeof usage.input_tokens === 'number') {
        this.usedTokens =
          usage.input_tokens +
          (typeof usage.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens
            : 0) +
          (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0)
      }
    } else if (frame.type === 'result') {
      this.publishUsage(claudeRecord(frame.modelUsage) ?? {})
      return
    } else {
      return
    }
    this.publishContext()
  }

  private updateTaskStarted(message: {
    task_id: string
    description: string
    subagent_type?: string
    task_type?: string
  }): void {
    if (!message.subagent_type && message.task_type !== 'local_agent') {
      return
    }
    this.subagents.set(message.task_id, {
      id: message.task_id,
      agentType: message.subagent_type ?? 'agent',
      description: message.description,
      state: 'working',
      startedAt: Date.now()
    })
    this.publishSubagents()
  }

  private updateTaskProgress(message: {
    task_id: string
    description: string
    subagent_type?: string
  }): void {
    const current = this.subagents.get(message.task_id)
    if (!current && !message.subagent_type) {
      return
    }
    this.subagents.set(message.task_id, {
      id: message.task_id,
      ...(message.subagent_type || current?.agentType
        ? { agentType: message.subagent_type ?? current?.agentType }
        : {}),
      description: message.description || current?.description,
      state: 'working',
      startedAt: current?.startedAt ?? Date.now()
    })
    this.publishSubagents()
  }

  private updateTaskStatus(taskId: string, status?: string, description?: string): void {
    const current = this.subagents.get(taskId)
    if (!current) {
      return
    }
    this.subagents.set(taskId, {
      ...current,
      ...(description ? { description } : {}),
      state:
        status === 'failed'
          ? 'blocked'
          : status === 'pending' || status === 'paused'
            ? 'waiting'
            : status === 'running'
              ? 'working'
              : 'idle'
    })
    this.publishSubagents()
  }

  private publishSubagents(): void {
    this.sink?.setSubagents([...this.subagents.values()])
  }

  private publishUsage(modelUsage: Record<string, unknown>): void {
    const entries = Object.entries(modelUsage).flatMap(([id, value]) => {
      const usage = claudeRecord(value)
      return usage &&
        typeof usage.contextWindow === 'number' &&
        typeof usage.inputTokens === 'number' &&
        typeof usage.cacheCreationInputTokens === 'number' &&
        typeof usage.cacheReadInputTokens === 'number'
        ? [
            [
              id,
              {
                contextWindow: usage.contextWindow,
                inputTokens: usage.inputTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                canonicalModel: claudeText(usage.canonicalModel)
              }
            ] as const
          ]
        : []
    })
    const current = this.currentModel?.replace(/\[1m\]$/i, '').toLowerCase()
    const matched = current
      ? entries.find(([id, usage]) =>
          [id, usage.canonicalModel].some((candidate) => {
            const normalized = candidate?.replace(/\[1m\]$/i, '').toLowerCase()
            return normalized === current || normalized?.startsWith(`${current}-`)
          })
        )?.[1]
      : undefined
    const main =
      matched ??
      entries.reduce<(typeof entries)[number] | undefined>((best, entry) => {
        const tokens = (usage: (typeof entry)[1]): number =>
          usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
        return !best || tokens(entry[1]) > tokens(best[1]) ? entry : best
      }, undefined)?.[1]
    this.maxTokens = main?.contextWindow ?? this.maxTokens
    this.publishContext()
  }

  private publishContext(): void {
    this.context = {
      model: this.currentModel,
      effort: this.currentEffort,
      fastMode: this.fastMode,
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      remainingTokens:
        this.maxTokens === null || this.usedTokens === null
          ? null
          : Math.max(0, this.maxTokens - this.usedTokens),
      usedPercent:
        this.maxTokens && this.usedTokens !== null
          ? Math.min(100, (this.usedTokens / this.maxTokens) * 100)
          : null,
      source: 'provider',
      observedAt: Date.now(),
      compaction: 'idle',
      compactionUpdatedAt: null
    }
    this.sink?.setContext(this.context)
  }
}
