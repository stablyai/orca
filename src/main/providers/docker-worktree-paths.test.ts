import { describe, expect, it } from 'vitest'
import { toDockerWorktreePath } from './docker-worktree-paths'

describe('toDockerWorktreePath', () => {
  it('maps paths whose first segment starts with two dots into the container', () => {
    expect(toDockerWorktreePath('/repo/..cache/foo', '/repo', '/workspace')).toBe(
      '/workspace/..cache/foo'
    )
  })

  it('keeps parent-relative paths on the host', () => {
    expect(toDockerWorktreePath('/bar', '/repo', '/workspace')).toBe('/bar')
  })

  it('keeps the parent directory itself on the host', () => {
    expect(toDockerWorktreePath('/parent', '/parent/repo', '/workspace')).toBe('/parent')
  })

  it('keeps absolute relative results on the host', () => {
    expect(toDockerWorktreePath('D:\\other\\file.txt', 'C:\\repo', '/workspace')).toBe(
      'D:\\other\\file.txt'
    )
  })
})
