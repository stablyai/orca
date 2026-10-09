import { describe, expect, it } from 'vitest'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentState
} from '../../shared/native-chat-types'
import { SubagentRosterRetention } from './subagent-roster-retention'

type Group = {
  groupId: string
  entries: Map<string, NativeChatSubagentEntry>
  lastSerialized: string | null
}

function group(groupId: string, state: NativeChatSubagentState, children = 64): Group {
  return {
    groupId,
    lastSerialized: 'admitted',
    entries: new Map(
      Array.from({ length: children }, (_, index) => {
        const id = `${groupId}:${index}`
        return [id, { id, label: id, state }]
      })
    )
  }
}

describe('host subagent roster settled retention', () => {
  it('shares one bound between superseded executions and evicted group identities', () => {
    const groups = new Map<string, Group>()
    const retention = new SubagentRosterRetention(groups, {
      maxGroups: 1,
      maxSettledIdentities: 2048,
      entries: (group) => group.entries.values(),
      identities: (roster) => roster.entries.keys()
    })
    const live = group('live', 'working', 1)
    groups.set(live.groupId, live)
    for (let index = 0; index < 2100; index++) {
      retention.rememberSettled(`superseded-${index}`)
    }
    const settled = group('settled', 'completed', 1)
    groups.set(settled.groupId, settled)
    retention.trim([settled])
    expect(retention.sizes()).toEqual({ groups: 1, settledIdentities: 2048 })
    expect(retention.hasSettled('superseded-52')).toBe(false)
    expect(retention.hasSettled('superseded-2099')).toBe(true)
    expect(retention.hasSettled('settled:0')).toBe(true)
    retention.clear()
    expect(retention.sizes().settledIdentities).toBe(0)
  })

  it('bounds settled groups and recent identities while retaining every live group', () => {
    const groups = new Map<string, Group>()
    const retention = new SubagentRosterRetention(groups, {
      maxGroups: 32,
      maxSettledIdentities: 32 * 64,
      entries: (group) => group.entries.values(),
      identities: (roster) => roster.entries.keys()
    })
    for (let index = 0; index < 35; index++) {
      const live = group(`live-${index}`, 'working')
      groups.set(live.groupId, live)
      retention.trim([live])
    }
    for (let index = 0; index < 70; index++) {
      const settled = group(`settled-${index}`, 'completed')
      groups.set(settled.groupId, settled)
      retention.trim([settled])
    }
    expect(retention.sizes()).toEqual({ groups: 35, settledIdentities: 32 * 64 })
    expect(retention.hasSettled('settled-0:0')).toBe(false)
    expect(retention.hasSettled('settled-69:0')).toBe(true)
    expect([...groups.keys()].every((id) => id.startsWith('live-'))).toBe(true)
    for (let index = 0; index < 70; index++) {
      const settled = group(`more-settled-${index}`, 'completed')
      const live = groups.get(`live-${index}`)
      if (live) {
        for (const entry of live.entries.values()) {
          entry.state = 'completed'
        }
        retention.trim([live])
      }
      groups.set(settled.groupId, settled)
      retention.trim([settled])
    }
    expect(retention.sizes()).toEqual({ groups: 32, settledIdentities: 32 * 64 })
  })

  it('re-derives settled eligibility when a retained child runs again or its write is refused', () => {
    const groups = new Map<string, Group>()
    const retention = new SubagentRosterRetention(groups, {
      maxGroups: 1,
      maxSettledIdentities: 64,
      entries: (group) => group.entries.values(),
      identities: (roster) => roster.entries.keys()
    })
    const old = group('old', 'completed', 1)
    groups.set(old.groupId, old)
    retention.trim([old])
    old.entries.set('old:0', { id: 'old:0', label: 'old', state: 'working' })
    retention.trim([old])
    const newGroup = group('new', 'working', 1)
    groups.set(newGroup.groupId, newGroup)
    retention.trim([newGroup])
    expect(groups.has('old')).toBe(true)
    old.entries.set('old:0', { id: 'old:0', label: 'old', state: 'completed' })
    old.lastSerialized = null
    retention.trim([old])
    expect(groups.has('old')).toBe(true)
    old.lastSerialized = 'admitted'
    retention.trim([old])
    expect(groups.has('old')).toBe(false)
    expect(retention.hasSettled('old:0')).toBe(true)
    groups.clear()
    retention.clear()
    expect(retention.sizes()).toEqual({ groups: 0, settledIdentities: 0 })
  })
})

it('keeps only the accessed inherited row during a trim and re-derives it on the next event', () => {
  const groups = new Map<string, Group>()
  const retention = new SubagentRosterRetention(groups, {
    maxGroups: 32,
    maxSettledIdentities: 2048,
    entries: (roster) => roster.entries.values(),
    identities: (roster) => roster.entries.keys()
  })
  for (let index = 0; index < 32; index++) {
    const live = group(`live-${index}`, 'working', 1)
    groups.set(live.groupId, live)
    retention.trim([live])
  }
  for (let index = 0; index < 70; index++) {
    const inherited = group(`inherited-${index}`, 'completed', 1)
    groups.set(inherited.groupId, inherited)
    retention.trim([inherited], inherited.groupId)
    expect(groups.size).toBe(33)
    expect(groups.has(inherited.groupId)).toBe(true)
  }
  retention.trim([])
  expect(groups.size).toBe(32)
  expect(retention.hasSettled('inherited-69:0')).toBe(true)
  const resumed = group('resumed', 'completed', 1)
  groups.set(resumed.groupId, resumed)
  retention.trim([resumed], resumed.groupId)
  resumed.entries.set('resumed:0', { id: 'resumed:0', label: 'resumed', state: 'working' })
  retention.trim([resumed])
  expect(groups.has(resumed.groupId)).toBe(true)
  expect(groups.size).toBe(33)
})
