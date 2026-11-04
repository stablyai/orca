import { describe, expect, it } from 'vitest'
import { readCodexSubagentAnnouncements } from './codex-subagent-activity'

describe('a Codex subagent read from its agent path', () => {
  it('announces no child for the tree root or the session’s own thread', () => {
    const item = (agentThreadId: string, agentPath: string) => ({
      type: 'subAgentActivity',
      id: `activity-${agentThreadId}`,
      kind: 'started',
      agentThreadId,
      agentPath
    })
    expect(readCodexSubagentAnnouncements(item('root-thread', '/root'), 'primary')).toEqual([])
    expect(readCodexSubagentAnnouncements(item('primary', '/root/x'), 'primary')).toEqual([])
    expect(readCodexSubagentAnnouncements(item('child', '/root/x'), 'primary')).toEqual([
      { agentThreadId: 'child', label: 'x', spawned: true }
    ])
  })
})
