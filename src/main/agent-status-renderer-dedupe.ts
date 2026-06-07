import type { AgentStatusIpcPayload } from '../shared/agent-status-types'

const DEFAULT_AGENT_STATUS_RENDERER_DEDUPE_WINDOW_MS = 1_000
const DEFAULT_AGENT_STATUS_RENDERER_DEDUPE_MAX_KEYS = 512

type AgentStatusRendererDedupeOptions = {
  windowMs?: number
  maxKeys?: number
}

type AgentStatusRendererDedupeEntry = {
  signature: string
  sentAt: number
}

export class AgentStatusRendererDedupe {
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly entries = new Map<string, AgentStatusRendererDedupeEntry>()

  constructor(options: AgentStatusRendererDedupeOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_AGENT_STATUS_RENDERER_DEDUPE_WINDOW_MS
    this.maxKeys = options.maxKeys ?? DEFAULT_AGENT_STATUS_RENDERER_DEDUPE_MAX_KEYS
  }

  shouldSend(status: AgentStatusIpcPayload, now = Date.now()): boolean {
    this.prune(now)
    const signature = getAgentStatusRendererDedupeSignature(status)
    const existing = this.entries.get(status.paneKey)
    if (existing?.signature === signature && now - existing.sentAt < this.windowMs) {
      return false
    }
    this.entries.set(status.paneKey, { signature, sentAt: now })
    this.prune(now)
    return true
  }

  clearPane(paneKey: string): void {
    this.entries.delete(paneKey)
  }

  clear(): void {
    this.entries.clear()
  }

  private prune(now: number): void {
    for (const [paneKey, entry] of this.entries) {
      if (now - entry.sentAt >= this.windowMs) {
        this.entries.delete(paneKey)
      }
    }
    while (this.entries.size > this.maxKeys) {
      const oldestKey = this.entries.keys().next().value
      if (typeof oldestKey !== 'string') {
        return
      }
      this.entries.delete(oldestKey)
    }
  }
}

function getAgentStatusRendererDedupeSignature(status: AgentStatusIpcPayload): string {
  return JSON.stringify({
    state: status.state,
    prompt: status.prompt,
    agentType: status.agentType,
    toolName: status.toolName,
    toolInput: status.toolInput,
    lastAssistantMessage: status.lastAssistantMessage,
    interrupted: status.interrupted,
    tabId: status.tabId,
    worktreeId: status.worktreeId,
    connectionId: status.connectionId,
    terminalHandle: status.terminalHandle,
    orchestration: status.orchestration
  })
}

export const agentStatusRendererDedupe = new AgentStatusRendererDedupe()
