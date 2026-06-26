import { describe, expect, it } from 'vitest'
import { buildDevcontainerProjectFields } from './project-fields'

describe('buildDevcontainerProjectFields', () => {
  it('maps a devcontainer to host-mounted repo fields with a relative worktree base', () => {
    expect(buildDevcontainerProjectFields({ hostFolder: '/Users/me/work/aprium' })).toEqual({
      path: '/Users/me/work/aprium',
      displayName: 'aprium',
      executionHostId: 'devcontainer:%2FUsers%2Fme%2Fwork%2Faprium',
      connectionId: 'devcontainer:%2FUsers%2Fme%2Fwork%2Faprium',
      worktreeBasePath: '.worktrees',
      relativePaths: true
    })
  })

  it('keeps connectionId equal to executionHostId so PTY routing resolves the docker provider', () => {
    const fields = buildDevcontainerProjectFields({ hostFolder: '/srv/lac' })
    expect(fields.connectionId).toBe(fields.executionHostId)
  })
})
