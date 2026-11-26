import { describe, expect, it, vi } from 'vitest'
import { detectGitLabProjectAvatar, gitLabAvatarFromBytes } from './gitlab-project-avatar'
import { sanitizeRepoIcon } from '../../shared/repository/appearance/repo-icon'
import * as projectRefs from '../gitlab/projects/gitlab-project-ref-resolution'
import { acquire, release } from '../gitlab/requests/glab-request-admission'

const AVATAR =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcElEQVR4AcXBAQ0CMQDAwNLMFZPBlGCDKcEGvsAB+Xwgvbvcro83IYlJTGISk5jEBgc8X3fOWnPzjcQkJrHBCWtufkViEpPY4ITn6843a26OkpjEJDY4Yc3Nr0hMYhKTmMQGB6y5+ReJSUxiEpOYxD6/5gu+HjgQaQAAAABJRU5ErkJggg=='

describe('GitLab avatar persistence boundary', () => {
  it('round-trips image bytes without retaining authenticated URLs', () => {
    const icon = gitLabAvatarFromBytes(Buffer.from(AVATAR, 'base64'), 'engineering/forge')
    expect(sanitizeRepoIcon(JSON.parse(JSON.stringify(icon)))).toEqual({
      type: 'image',
      source: 'gitlab',
      src: `data:image/png;base64,${AVATAR}`,
      label: 'engineering/forge'
    })
    expect(
      sanitizeRepoIcon({
        type: 'image',
        source: 'gitlab',
        src: 'https://gitlab.example.com/avatar.png?private_token=secret'
      })
    ).toBeUndefined()
  })

  it('refuses non-raster responses, oversized downloads, and decode bombs', () => {
    expect(gitLabAvatarFromBytes(Buffer.from('<html>Sign in</html>'), 'forge')).toBeNull()
    expect(gitLabAvatarFromBytes(Buffer.from('<svg></svg>'), 'forge')).toBeNull()
    const oversized = Buffer.alloc(256 * 1024 + 1)
    Buffer.from(AVATAR, 'base64').copy(oversized)
    expect(gitLabAvatarFromBytes(oversized, 'forge')).toBeNull()
    const largeDimensions = Buffer.from(AVATAR, 'base64')
    largeDimensions.writeUInt32BE(100_000, 16)
    expect(gitLabAvatarFromBytes(largeDimensions, 'forge')).toBeNull()
  })
})

it('treats admission timeout as unavailable without releasing another request’s slot', async () => {
  vi.useFakeTimers()
  const projectRef = vi
    .spyOn(projectRefs, 'getProjectRef')
    .mockResolvedValue({ host: 'gitlab.com', path: 'engineering/forge' })
  try {
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    await Promise.all([
      expect(detectGitLabProjectAvatar('/projects/forge')).resolves.toBeNull(),
      vi.advanceTimersByTimeAsync(30_000)
    ])
    await Promise.all([
      expect(acquire(1)).rejects.toThrow('Timed out waiting for a GitLab operation slot.'),
      vi.advanceTimersByTimeAsync(1)
    ])
  } finally {
    for (let slot = 0; slot < 4; slot++) {
      release()
    }
    projectRef.mockRestore()
    vi.useRealTimers()
  }
})
