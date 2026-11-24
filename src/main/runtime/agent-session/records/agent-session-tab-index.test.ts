import { describe, expect, it } from 'vitest'
import {
  AgentSessionTabTable,
  agentSessionTabTableFromStored,
  storedAgentSessionBackground
} from './agent-session-tab-index'

describe('AgentSessionTabTable ended chats', () => {
  it('ends a background chat until it is shown again', () => {
    const table = new AgentSessionTabTable([], ['s1', 's2'])
    table.end('s1')
    expect(table.isEnded('s1')).toBe(true)
    expect(table.isInBackground('s1')).toBe(false)
    expect(table.tabIdFor('s1')).toBeUndefined()

    table.show('s1')
    expect(table.isEnded('s1')).toBe(false)
  })

  it('keeps an ended chat ended when a late legacy close holds it in the background', () => {
    const table = new AgentSessionTabTable([['tab-a', 'a']], ['b'])
    table.end('a')
    table.end('b')
    // A legacy `agentSession.close` captured before End lands its background write afterwards.
    table.holdInBackground('a')
    table.holdInBackground('b')
    for (const id of ['a', 'b']) {
      expect(table.isEnded(id)).toBe(true)
      expect(table.isInBackground(id)).toBe(false)
    }
    const restored = agentSessionTabTableFromStored([], storedAgentSessionBackground(table))
    expect(restored.isEnded('b')).toBe(true)
    expect(restored.isInBackground('b')).toBe(false)
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

describe('AgentSessionTabTable ended chats across a write', () => {
  it('shares them with its clone, and reports only what the clone changed', () => {
    const published = new AgentSessionTabTable([['tab-x', 'x']], [], ['a', 'b'])
    const unrelated = published.clone()
    unrelated.show('y')
    expect(unrelated.endedChangesSince(published)).toBeNull()

    const draft = published.clone()
    draft.end('x')
    draft.show('a')
    draft.end('c')
    draft.show('c')
    expect(draft.endedChangesSince(published)).toEqual({ add: ['x'], remove: ['a'] })
    // The draft copied on its first change; the table it came from is as it was.
    expect(published.endedSessionIds()).toEqual(['a', 'b'])
    expect(draft.equals(published)).toBe(false)
  })

  it('compares whole sets against a table it was not cloned from', () => {
    const fresh = new AgentSessionTabTable([], [], ['a'])
    expect(fresh.endedChangesSince(null)).toEqual({ add: ['a'], remove: [] })
    expect(fresh.endedChangesSince(new AgentSessionTabTable([], [], ['a', 'b']))).toEqual({
      add: [],
      remove: ['b']
    })
  })
})

describe('AgentSessionTabTable forgetting a chat', () => {
  it('drops its ended mark with its record, and writes that as a removal', () => {
    const published = new AgentSessionTabTable([], [], ['gone', 'kept'])
    const draft = published.clone()
    draft.forget('gone')
    expect(draft.isEnded('gone')).toBe(false)
    expect(draft.endedSessionIds()).toEqual(['kept'])
    expect(draft.endedChangesSince(published)).toEqual({ add: [], remove: ['gone'] })
  })
})
