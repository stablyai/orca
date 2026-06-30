import { describe, expect, it } from 'vitest'
import { containerToHost, hostToContainer, type ContainerMount } from './path-map'

const REPO_MOUNT: ContainerMount = {
  source: '/Users/me/work/aprium',
  destination: '/workspaces/aprium'
}

describe('hostToContainer', () => {
  it('maps the mount root itself', () => {
    expect(hostToContainer('/Users/me/work/aprium', [REPO_MOUNT])).toBe('/workspaces/aprium')
  })

  it('maps a worktree path beneath the mount root', () => {
    expect(hostToContainer('/Users/me/work/aprium/.worktrees/feature-x', [REPO_MOUNT])).toBe(
      '/workspaces/aprium/.worktrees/feature-x'
    )
  })

  it('tolerates trailing slashes on input and mount', () => {
    const mount: ContainerMount = {
      source: '/Users/me/work/aprium/',
      destination: '/workspaces/aprium/'
    }
    expect(hostToContainer('/Users/me/work/aprium/src/', [mount])).toBe('/workspaces/aprium/src')
  })

  it('normalizes . and .. segments', () => {
    expect(hostToContainer('/Users/me/work/aprium/src/../lib', [REPO_MOUNT])).toBe(
      '/workspaces/aprium/lib'
    )
  })

  it('respects path boundaries (no sibling-prefix false match)', () => {
    expect(hostToContainer('/Users/me/work/aprium-staging', [REPO_MOUNT])).toBeNull()
  })

  it('returns null when the path is under no mount', () => {
    expect(hostToContainer('/Users/me/other/repo', [REPO_MOUNT])).toBeNull()
  })

  it('returns null for non-absolute input', () => {
    expect(hostToContainer('relative/path', [REPO_MOUNT])).toBeNull()
  })

  it('picks the most specific (longest) matching mount when mounts nest', () => {
    const mounts: ContainerMount[] = [
      REPO_MOUNT,
      { source: '/Users/me/work/aprium/node_modules', destination: '/opt/deps' }
    ]
    expect(hostToContainer('/Users/me/work/aprium/node_modules/pkg/index.js', mounts)).toBe(
      '/opt/deps/pkg/index.js'
    )
    // A sibling path still resolves through the outer mount.
    expect(hostToContainer('/Users/me/work/aprium/src/index.ts', mounts)).toBe(
      '/workspaces/aprium/src/index.ts'
    )
  })
})

describe('containerToHost', () => {
  it('maps the destination root itself', () => {
    expect(containerToHost('/workspaces/aprium', [REPO_MOUNT])).toBe('/Users/me/work/aprium')
  })

  it('maps a path beneath the destination', () => {
    expect(containerToHost('/workspaces/aprium/.worktrees/feat', [REPO_MOUNT])).toBe(
      '/Users/me/work/aprium/.worktrees/feat'
    )
  })

  it('returns null when the container path is under no mount', () => {
    expect(containerToHost('/tmp/scratch', [REPO_MOUNT])).toBeNull()
  })

  it('round-trips host -> container -> host', () => {
    const hostPath = '/Users/me/work/aprium/.worktrees/feature-x'
    const containerPath = hostToContainer(hostPath, [REPO_MOUNT])
    expect(containerPath).not.toBeNull()
    expect(containerToHost(containerPath as string, [REPO_MOUNT])).toBe(hostPath)
  })
})
