import { describe, expect, it } from 'vitest'
import { agentSessionWorkspacePresence } from './agent-session-workspace-presence'

const workspaceId = 'repo::/workspace/checkout'
const record = (workspace: string, executionHostId = 'local') => ({
  location: { workspaceId: workspace, executionHostId }
})

describe('agent session workspace presence', () => {
  it('refuses uncertain record sets before iterating them', () => {
    const records = new Map<string, ReturnType<typeof record>>()
    records.values = () => {
      throw new Error('unexpected iteration')
    }
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 1 } }, false, workspaceId)
    ).toBe('unknown')
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 0 } }, true, workspaceId)
    ).toBe('unknown')
  })

  it('accepts the exact record limit and refuses excess records before iterating', () => {
    const records = new Map(
      Array.from({ length: 10000 }, (_, index) => [String(index), record('other', 'ssh:other')])
    )
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 0 } }, false, workspaceId)
    ).toBe('absent')
    records.set('excess', record(workspaceId))
    records.values = () => {
      throw new Error('unexpected excess iteration')
    }
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 0 } }, false, workspaceId)
    ).toBe('unknown')
  })

  it('returns after the first matching record without consuming later records', () => {
    const records = new Map([
      ['first', record(workspaceId)],
      ['second', record('other', 'ssh:other')]
    ])
    Object.defineProperty(records.get('second'), 'location', {
      get: () => {
        throw new Error('unexpected later record')
      }
    })
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 0 } }, false, workspaceId)
    ).toBe('present')
  })
})
