import { describe, expect, it } from 'vitest'
import { resolveCliWorktreeCreateBranchNameOverride } from './worktree-create-branch-override'

describe('resolveCliWorktreeCreateBranchNameOverride', () => {
  it('uses --branch when provided', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'yoyo-prefix-test',
        branch: 'yoyo/prefix-test'
      })
    ).toBe('yoyo/prefix-test')
  })

  it('trims --branch', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'folder',
        branch: '  feature/slash  '
      })
    ).toBe('feature/slash')
  })

  it('keeps slash-containing --name as the branch when --branch is absent', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'yoyo/prefix-test',
        branch: undefined
      })
    ).toBe('yoyo/prefix-test')
  })

  it('leaves plain names without an override so the runtime derives the branch', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'plain-name',
        branch: undefined
      })
    ).toBeUndefined()
  })

  it('prefers --branch over a slash-containing --name', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'yoyo/prefix-test',
        branch: 'other/branch'
      })
    ).toBe('other/branch')
  })

  it('treats blank --branch as absent and falls back to slash name', () => {
    expect(
      resolveCliWorktreeCreateBranchNameOverride({
        name: 'user/task',
        branch: '   '
      })
    ).toBe('user/task')
  })
})
