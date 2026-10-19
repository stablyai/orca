import { describe, expect, it } from 'vitest'
import {
  codexSubagentLabel,
  isCodexRootAgentActivity,
  readCodexSubagentAnnouncements
} from './codex-subagent-activity'

const activity = (agentPath: string | null) => ({
  kind: 'started',
  agentThreadId: 'child',
  agentPath
})

describe('a Codex subagent read from its agent path', () => {
  it.each(['/root', '/root/', '/root//'])('reads %s as the turn itself, never a child', (path) => {
    expect(isCodexRootAgentActivity(activity(path))).toBe(true)
  })

  it('counts a single-segment path other than root, and a path-less one, as a child', () => {
    expect(isCodexRootAgentActivity(activity('/morpheus'))).toBe(false)
    expect(isCodexRootAgentActivity(activity(null))).toBe(false)
  })

  it('labels a child by its trimmed last segment, and by nothing when that is blank', () => {
    expect(codexSubagentLabel(activity('/root//list_directory'))).toBe('list_directory')
    expect(codexSubagentLabel(activity('/root/ read '))).toBe('read')
    expect(codexSubagentLabel(activity('/root/   '))).toBeNull()
  })

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
