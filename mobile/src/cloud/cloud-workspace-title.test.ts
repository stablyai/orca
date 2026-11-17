import { describe, expect, it } from 'vitest'
import { nextCloudWorkspaceTitle } from './cloud-workspace-display'

describe('nextCloudWorkspaceTitle', () => {
  it('numbers a repeated title from 2 and skips numbers already taken', () => {
    expect(nextCloudWorkspaceTitle('Hello-World', [])).toBe('Hello-World')
    expect(nextCloudWorkspaceTitle('Hello-World', [{ title: 'Hello-World' }])).toBe('Hello-World 2')
    expect(
      nextCloudWorkspaceTitle('Hello-World', [{ title: 'Hello-World' }, { title: 'Hello-World 2' }])
    ).toBe('Hello-World 3')
  })
})
