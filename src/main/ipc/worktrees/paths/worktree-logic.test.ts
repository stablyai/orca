import { describe, expect, it } from 'vitest'
import { sanitizeWorktreeName } from './worktree-logic'
import { sanitizeWorktreeDisplayName } from '../creation/worktree-display-name'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'

describe('sanitizeWorktreeName', () => {
  it('preserves non-ASCII letters and numbers', () => {
    expect(sanitizeWorktreeName('中文')).toBe('中文')
    expect(sanitizeWorktreeName('日本語 テスト')).toBe('日本語-テスト')
    expect(sanitizeWorktreeName('café-déjà')).toBe('café-déjà')
    expect(sanitizeWorktreeName('Привет мир')).toBe('Привет-мир')
  })

  it('keeps vowel signs and viramas, which are combining marks, with their letters', () => {
    expect(sanitizeWorktreeName('हिन्दी परीक्षण')).toBe('हिन्दी-परीक्षण')
    expect(sanitizeWorktreeName('ที่นี่ ทดสอบ')).toBe('ที่นี่-ทดสอบ')
  })

  it('composes decomposed accents and split vowels instead of turning them into dashes', () => {
    expect(sanitizeWorktreeName('Rene\u0301e')).toBe('Ren\u00e9e')
    expect(sanitizeWorktreeName('Tie\u0302\u0301ng Vie\u0323\u0302t')).toBe('Ti\u1ebfng-Vi\u1ec7t')
    expect(sanitizeWorktreeName('\u0995\u09c7\u09be\u09a8')).toBe('\u0995\u09cb\u09a8')
  })

  it('turns an overlong mark run into a dash instead of composing it', () => {
    expect(sanitizeWorktreeName(`a${'\u0301'.repeat(100)}b`)).toBe('a-b')
  })

  it('turns invisible marks into dashes as other separators', () => {
    expect(sanitizeWorktreeName('Fix\ufe0f login')).toBe('Fix-login')
    expect(sanitizeWorktreeName('a\u034fb')).toBe('a-b')
  })
})

describe('sanitizeWorktreeDisplayName', () => {
  it('strips bidi override controls from external artifact titles', () => {
    expect(sanitizeWorktreeDisplayName('Review \u202eexe.txt')).toBe('Review exe.txt')
  })
})

describe('areWorktreePathsEqual', () => {
  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })
})
