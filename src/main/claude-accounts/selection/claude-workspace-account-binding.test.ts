import { describe, expect, it } from 'vitest'
import {
  claudeAccountBindingForWorkspace,
  type ClaudeWorkspaceBindingLookup
} from './claude-workspace-account-binding'

const axion = { kind: 'folder', configDir: 'C:\\Users\\me\\.claude_axion' } as const
const personal = { kind: 'managed', accountId: 'personal-1' } as const

const repos: Record<string, ReturnType<ClaudeWorkspaceBindingLookup['getRepo']>> = {
  'repo-own': { claudeAccount: personal, projectGroupId: 'child' },
  'repo-grouped': { projectGroupId: 'child' },
  'repo-loose': { projectGroupId: null },
  // Stored data can hold what the type forbids; the lookup must reject it.
  'repo-bad': JSON.parse('{"claudeAccount":{"kind":"folder","configDir":"relative"}}')
}

function lookup(
  overrides: Partial<ClaudeWorkspaceBindingLookup> = {}
): ClaudeWorkspaceBindingLookup {
  return {
    getRepo: (id) => repos[id],
    getFolderWorkspace: (id) => (id === 'f1' ? { projectGroupId: 'child' } : undefined),
    getProjectGroups: () => [
      { id: 'parent', parentGroupId: null, claudeAccount: axion },
      { id: 'child', parentGroupId: 'parent' }
    ],
    ...overrides
  }
}

describe('claudeAccountBindingForWorkspace', () => {
  it('prefers the project, then the nearest group, and never invents a binding', () => {
    expect(claudeAccountBindingForWorkspace('worktree:repo-own::C:/r', lookup())).toEqual(personal)
    expect(claudeAccountBindingForWorkspace('worktree:repo-grouped::C:/r', lookup())).toEqual(axion)
    expect(claudeAccountBindingForWorkspace('folder:f1', lookup())).toEqual(axion)
    expect(claudeAccountBindingForWorkspace('worktree:repo-loose::C:/r', lookup())).toBeNull()
    // A malformed saved binding must not become an account selection.
    expect(claudeAccountBindingForWorkspace('worktree:repo-bad::C:/r', lookup())).toBeNull()
  })

  it('stops on a cyclic group chain', () => {
    const cyclic = lookup({
      getProjectGroups: () => [
        { id: 'child', parentGroupId: 'parent' },
        { id: 'parent', parentGroupId: 'child' }
      ]
    })
    expect(claudeAccountBindingForWorkspace('worktree:repo-grouped::C:/r', cyclic)).toBeNull()
  })
})
