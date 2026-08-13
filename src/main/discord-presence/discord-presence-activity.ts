import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

export type DiscordPresenceSnapshot = {
  working: number
  blocked: number
  waiting: number
  done: number
  active: number
  total: number
  agentTypes: string[]
  startedAt: number
  currentTool?: string
}

export function aggregateAgentStatus(
  entries: readonly AgentStatusIpcPayload[]
): DiscordPresenceSnapshot {
  let working = 0
  let blocked = 0
  let waiting = 0
  let done = 0
  const activeTypes = new Set<string>()
  let startedAt = 0
  let currentTool: string | undefined

  for (const e of entries) {
    // providerSessionOnly or missing paneKey => skip
    if (e.providerSessionOnly || !e.paneKey) continue

    switch (e.state) {
      case 'working': {
        working++
        if (e.agentType) activeTypes.add(e.agentType)
        if (e.toolName) currentTool = e.toolName
        if (startedAt === 0 || e.receivedAt < startedAt) startedAt = e.receivedAt
        break
      }
      case 'blocked': {
        blocked++
        if (e.agentType) activeTypes.add(e.agentType)
        if (startedAt === 0 || e.receivedAt < startedAt) startedAt = e.receivedAt
        break
      }
      case 'waiting': {
        waiting++
        if (e.agentType) activeTypes.add(e.agentType)
        if (startedAt === 0 || e.receivedAt < startedAt) startedAt = e.receivedAt
        break
      }
      case 'done': {
        done++
        break
      }
    }
  }

  const active = working + blocked + waiting
  return {
    working,
    blocked,
    waiting,
    done,
    active,
    total: active + done,
    agentTypes: [...activeTypes].sort(),
    startedAt,
    ...(currentTool !== undefined ? { currentTool } : {})
  }
}