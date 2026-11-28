import { describe, expect, it, vi } from 'vitest'
import {
  getWorktreeNameGitPlatform,
  sanitizeWorktreeBranchName,
  sanitizeWorktreeName
} from './worktree-logic'
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

  it('prefixes Windows device names, which Git for Windows cannot create a folder or ref for', () => {
    expect(sanitizeWorktreeName('con', 'win32')).toBe('_con')
    expect(sanitizeWorktreeName('AUX', 'win32')).toBe('_AUX')
    expect(sanitizeWorktreeName('nul.txt', 'win32')).toBe('_nul.txt')
    expect(sanitizeWorktreeName('com0', 'win32')).toBe('com0')
    expect(sanitizeWorktreeName('console', 'win32')).toBe('console')
    expect(sanitizeWorktreeName('COM10', 'win32')).toBe('COM10')
    expect(sanitizeWorktreeBranchName('con', 'win32')).toBe('_con')
    expect(sanitizeWorktreeBranchName('aux/nul.txt', 'win32')).toBe('_aux/_nul.txt')
    expect(sanitizeWorktreeBranchName('fix/console', 'win32')).toBe('fix/console')
  })

  it('keeps Windows device names off Windows', () => {
    expect(sanitizeWorktreeName('con', 'linux')).toBe('con')
    expect(sanitizeWorktreeBranchName('aux/nul.txt', 'linux')).toBe('aux/nul.txt')
  })

  it('keeps Windows device names for WSL-backed repos on Windows', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(getWorktreeNameGitPlatform('C:\\repo', {})).toBe('win32')
      expect(getWorktreeNameGitPlatform('C:\\repo', { wslDistro: 'Ubuntu' })).toBe('linux')
      expect(getWorktreeNameGitPlatform('\\\\wsl$\\Ubuntu\\home\\me\\repo', {})).toBe('linux')
      expect(getWorktreeNameGitPlatform('//wsl.localhost/Ubuntu/home/me/repo', {})).toBe('linux')
    } finally {
      platform.mockRestore()
    }
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
