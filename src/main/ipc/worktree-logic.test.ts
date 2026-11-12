import { describe, expect, it } from 'vitest'
import { sanitizeWorktreeName, ensurePathWithinWorkspace } from './worktree-logic'
import { sanitizeWorktreeDisplayName } from './worktree-display-name'
import { areWorktreePathsEqual } from '../git/worktrees/catalog/worktree-path-comparison'

describe('sanitizeWorktreeName', () => {
  it('preserves non-ASCII letters and numbers', () => {
    expect(sanitizeWorktreeName('中文')).toBe('中文')
    expect(sanitizeWorktreeName('日本語 テスト')).toBe('日本語-テスト')
    expect(sanitizeWorktreeName('café-déjà')).toBe('café-déjà')
    expect(sanitizeWorktreeName('Привет мир')).toBe('Привет-мир')
  })
})

describe('sanitizeWorktreeDisplayName', () => {
  it('strips bidi override controls from external artifact titles', () => {
    expect(sanitizeWorktreeDisplayName('Review \u202eexe.txt')).toBe('Review exe.txt')
  })
})

describe('ensurePathWithinWorkspace', () => {
  it('throws when path traverses outside workspace', () => {
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow(
      'Invalid worktree path'
    )
  })
})

describe('areWorktreePathsEqual', () => {
  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })
})
