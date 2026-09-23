import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import { resolveLocalBoundClaudeHomes } from './bound-claude-home-bindings'

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id'>): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('resolveLocalBoundClaudeHomes', () => {
  it('returns one row per owning group for local groups', () => {
    const groups = [
      group({ id: 'parent', claudeConfigDir: '/Users/dana/.claude-work' }),
      group({ id: 'child', parentGroupId: 'parent' }),
      group({ id: 'other', claudeConfigDir: 'C:\\Users\\dana\\.claude-win' })
    ]

    expect(resolveLocalBoundClaudeHomes(groups)).toEqual([
      { groupId: 'parent', configDir: '/Users/dana/.claude-work' },
      { groupId: 'other', configDir: 'C:\\Users\\dana\\.claude-win' }
    ])
  })

  it('skips a group owned by an SSH or runtime execution host', () => {
    // Why: a config dir is a filesystem path on exactly one host. Reading a remote group's path
    // on the client either reports a healthy group as signed out, or — worse — finds a local file
    // of the same name and renders the developer's own quota under the remote group's name.
    const groups = [
      group({ id: 'ci', executionHostId: 'ssh:build-box', claudeConfigDir: '/home/ci/.claude-ci' }),
      group({
        id: 'legacy-ssh',
        connectionId: 'build-box',
        claudeConfigDir: '/home/ci/.claude-ci'
      }),
      group({ id: 'cloud', executionHostId: 'runtime:env-1', claudeConfigDir: '/root/.claude' }),
      group({ id: 'local', claudeConfigDir: '/Users/dana/.claude-work' })
    ]

    expect(resolveLocalBoundClaudeHomes(groups)).toEqual([
      { groupId: 'local', configDir: '/Users/dana/.claude-work' }
    ])
  })

  it('never inherits a binding across the execution-host boundary', () => {
    const groups = [
      group({
        id: 'remote-parent',
        executionHostId: 'ssh:build-box',
        claudeConfigDir: '/home/ci/.claude-ci'
      }),
      group({ id: 'local-child', parentGroupId: 'remote-parent' })
    ]

    expect(resolveLocalBoundClaudeHomes(groups)).toEqual([])
  })

  it('ignores a value that does not name one absolute directory', () => {
    const groups = [
      group({ id: 'relative', claudeConfigDir: '.claude' }),
      group({ id: 'blank', claudeConfigDir: '   ' })
    ]

    expect(resolveLocalBoundClaudeHomes(groups)).toEqual([])
  })
})
