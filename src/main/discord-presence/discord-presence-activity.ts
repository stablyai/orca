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

export type DiscordActivity = {
  details: string
  state: string
  assets: { large_image: string; large_text: string }
  timestamps?: { start: number }
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

export function buildDiscordActivity(
  snapshot: DiscordPresenceSnapshot,
  assetKey: string
): DiscordActivity | null {
  if (snapshot.active === 0) return null

  const details = `${snapshot.working} agent${snapshot.working !== 1 ? 's' : ''} working`

  // Build state: agent types (up to 3) + optional blocked signal
  const parts: string[] = []
  const displayed = snapshot.agentTypes.slice(0, 3)
  parts.push(...displayed)
  if (snapshot.agentTypes.length > 3) parts.push('…')

  if (snapshot.blocked > 0) {
    parts.push(`${snapshot.blocked} waiting for you`)
  }

  const state = parts.map(capitalize).join(' · ')

  const activity: DiscordActivity = {
    details,
    state,
    assets: { large_image: assetKey, large_text: 'Orca' }
  }

  if (snapshot.startedAt > 0) {
    activity.timestamps = { start: snapshot.startedAt }
  }

  return activity
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}