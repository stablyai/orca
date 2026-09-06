import { describe, expect, it } from 'vitest'
import { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'

describe('mobile web task target authority', () => {
  it('keeps provider targets opaque, stable, and revocable', () => {
    const authority = new MobileWebTaskTargetAuthority((length) => new Uint8Array(length).fill(6))
    const target = {
      repoId: 'private-repo',
      number: 9,
      type: 'mr' as const,
      projectRef: { host: 'gitlab.example.com', path: 'private/upstream' }
    }

    const pageId = authority.registerGitLab(target)

    expect(pageId).toMatch(/^task_target_0_[a-f0-9]{32}$/)
    expect(pageId).not.toContain('private')
    expect(authority.registerGitLab(target)).toBe(pageId)
    expect(authority.resolveGitLab(pageId)).toEqual(target)
    expect(() => authority.resolveGitLab(`${pageId}x`)).toThrow('not_found')

    const gitHubTarget = { repoId: 'private-repo', number: 7, type: 'issue' as const }
    const gitHubPageId = authority.registerGitHub(gitHubTarget)
    expect(gitHubPageId).not.toContain('private')
    expect(authority.registerGitHub(gitHubTarget)).toBe(gitHubPageId)
    expect(authority.resolveGitHub(gitHubPageId)).toEqual(gitHubTarget)
    expect(authority.resolveHosted(gitHubPageId)).toEqual({
      provider: 'github',
      ...gitHubTarget
    })
    expect(() =>
      authority.assertHostedTarget(gitHubPageId, { provider: 'github', ...gitHubTarget })
    ).not.toThrow()

    const projectTarget = {
      owner: 'stablyai',
      host: 'github.com',
      ownerType: 'organization' as const,
      projectNumber: 3,
      viewId: 'view-node',
      rowId: 'row-node',
      itemType: 'ISSUE' as const,
      repository: 'stablyai/orca',
      number: 7
    }
    const projectPageId = authority.registerGitHubProject(projectTarget)
    expect(projectPageId).not.toContain('stablyai')
    expect(authority.resolveGitHubProject(projectPageId)).toEqual(projectTarget)
    expect(() => authority.assertGitHubProjectTarget(projectPageId, projectTarget)).not.toThrow()

    const linearTarget = { issueId: 'linear-private', workspaceId: 'linear-workspace' }
    const linearPageId = authority.registerLinear(linearTarget)
    expect(() => authority.assertLinearTarget(linearPageId, linearTarget)).not.toThrow()

    authority.clear()
    expect(() => authority.resolveGitLab(pageId)).toThrow('not_found')
    expect(() => authority.resolveGitHub(gitHubPageId)).toThrow('not_found')
    expect(() => authority.resolveGitHubProject(projectPageId)).toThrow('not_found')
    expect(() =>
      authority.assertHostedTarget(gitHubPageId, { provider: 'github', ...gitHubTarget })
    ).toThrow('not_found')
    expect(() => authority.assertGitHubProjectTarget(projectPageId, projectTarget)).toThrow(
      'not_found'
    )
    expect(() => authority.assertLinearTarget(linearPageId, linearTarget)).toThrow('not_found')
  })
})
