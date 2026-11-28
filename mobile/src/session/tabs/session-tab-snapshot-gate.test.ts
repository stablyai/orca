import { describe, expect, it } from 'vitest'
import { keepChatsHostCannotRead } from './session-tab-snapshot-gate'

const chat = { id: 'agent-session:a', type: 'agent-session', isActive: true }
const terminal = { id: 't1', type: 'terminal', isActive: false }
const frame = (tabs: (typeof chat)[], agentSessionsUnverifiable?: true) => ({
  publicationEpoch: 'renderer:1',
  snapshotVersion: 2,
  tabs,
  ...(agentSessionsUnverifiable ? { agentSessionsUnverifiable } : {})
})

describe('keepChatsHostCannotRead', () => {
  it('never reads a host that cannot see its chats as closing them', () => {
    const activeTerminal = { ...terminal, isActive: true }
    expect(keepChatsHostCannotRead(frame([activeTerminal], true), [chat, terminal])).toEqual([
      { ...chat, isActive: false },
      activeTerminal
    ])
    expect(keepChatsHostCannotRead(frame([], true), [terminal])).toEqual([])
    expect(keepChatsHostCannotRead(frame([terminal]), [chat, terminal])).toEqual([terminal])
  })
})
