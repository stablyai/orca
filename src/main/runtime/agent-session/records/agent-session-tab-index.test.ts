import { describe, expect, it } from 'vitest'
import {
  AgentSessionTabTable,
  agentSessionTabTableFromStored,
  storedAgentSessionBackground
} from './agent-session-tab-index'

describe('AgentSessionTabTable ended chats', () => {
  it('ends a background chat until it is shown or held again', () => {
    const table = new AgentSessionTabTable([], ['s1', 's2'])
    table.end('s1')
    expect(table.isEnded('s1')).toBe(true)
    expect(table.isInBackground('s1')).toBe(false)
    expect(table.tabIdFor('s1')).toBeUndefined()

    table.show('s1')
    expect(table.isEnded('s1')).toBe(false)

    table.end('s2')
    table.holdInBackground('s2')
    expect(table.isEnded('s2')).toBe(false)
    expect(table.isInBackground('s2')).toBe(true)
  })

  it('keeps ended chats across storage and clones', () => {
    const table = new AgentSessionTabTable([['tab-a', 'a']], ['b'])
    table.end('a')
    const restored = agentSessionTabTableFromStored(
      table.entries(),
      storedAgentSessionBackground(table)
    )
    expect(restored.isEnded('a')).toBe(true)
    expect(restored.isInBackground('b')).toBe(true)
    expect(restored.clone().isEnded('a')).toBe(true)
    expect(restored.equals(table)).toBe(true)
  })

  it('never stores a chat as ended and listed at once', () => {
    const restored = agentSessionTabTableFromStored([['tab-a', 'a']], {
      ids: ['b'],
      backfilled: false,
      ended: ['a', 'b', 'c']
    })
    expect(restored.isEnded('a')).toBe(false)
    expect(restored.isEnded('b')).toBe(false)
    expect(restored.isEnded('c')).toBe(true)
  })
})

describe('AgentSessionTabTable showings', () => {
  it('names a new showing when a tab returns under the same id', () => {
    const table = new AgentSessionTabTable()
    table.show('s1')
    const first = table.showingOf('s1')
    expect(first).not.toBeNull()

    table.hide('s1')
    expect(table.showingOf('s1')).toBeNull()
    table.show('s1')
    expect(table.showingOf('s1')).not.toBe(first)
  })

  it('renews an already listed tab on an explicit show and keeps it through a clone', () => {
    const table = new AgentSessionTabTable()
    table.show('s1')
    const first = table.showingOf('s1')
    expect(table.clone().showingOf('s1')).toBe(first)

    table.renewShowing('s1')
    expect(table.showingOf('s1')).not.toBe(first)
  })
})
