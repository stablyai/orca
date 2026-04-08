import { describe, expect, it } from 'vitest'
import { isWorktreesDirIgnoredByGitignore, appendWorktreesEntry } from './gitignore'

describe('isWorktreesDirIgnoredByGitignore', () => {
  it('returns false for null content (no .gitignore file)', () => {
    expect(isWorktreesDirIgnoredByGitignore(null)).toBe(false)
  })

  it('returns false for empty content', () => {
    expect(isWorktreesDirIgnoredByGitignore('')).toBe(false)
  })

  it('recognizes .worktrees/', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees/')).toBe(true)
  })

  it('recognizes .worktrees (no trailing slash)', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees')).toBe(true)
  })

  it('recognizes /.worktrees/', () => {
    expect(isWorktreesDirIgnoredByGitignore('/.worktrees/')).toBe(true)
  })

  it('recognizes /.worktrees', () => {
    expect(isWorktreesDirIgnoredByGitignore('/.worktrees')).toBe(true)
  })

  it('recognizes the entry among unrelated lines', () => {
    const content = ['node_modules/', 'dist/', '.worktrees/', '.env'].join('\n')
    expect(isWorktreesDirIgnoredByGitignore(content)).toBe(true)
  })

  it('ignores comment lines', () => {
    expect(isWorktreesDirIgnoredByGitignore('# .worktrees/')).toBe(false)
  })

  it('ignores negation rules (!.worktrees/)', () => {
    expect(isWorktreesDirIgnoredByGitignore('!.worktrees/')).toBe(false)
  })

  it('does not false-positive on substring matches', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees-cache/')).toBe(false)
    expect(isWorktreesDirIgnoredByGitignore('my.worktrees/')).toBe(false)
  })

  it('handles CRLF line endings', () => {
    expect(isWorktreesDirIgnoredByGitignore('node_modules/\r\n.worktrees/\r\n')).toBe(true)
  })

  it('does NOT match leading-whitespace patterns (\\t.worktrees/)', () => {
    // Regression guard: git treats leading whitespace as part of the pattern,
    // so an indented line is a literal filename, not a rule. Never `.trim()`.
    expect(isWorktreesDirIgnoredByGitignore('\t.worktrees/')).toBe(false)
    expect(isWorktreesDirIgnoredByGitignore('  .worktrees/')).toBe(false)
  })

  it('does NOT match trailing-whitespace patterns (.worktrees/ )', () => {
    // Regression guard: trailing whitespace is significant in gitignore patterns
    // unless escaped. Exact-string matching only.
    expect(isWorktreesDirIgnoredByGitignore('.worktrees/ ')).toBe(false)
  })
})

describe('appendWorktreesEntry', () => {
  it('appends to empty content', () => {
    expect(appendWorktreesEntry('')).toBe('.worktrees/\n')
  })

  it('appends to null content', () => {
    expect(appendWorktreesEntry(null)).toBe('.worktrees/\n')
  })

  it('adds a leading newline when prior content does not end with one', () => {
    expect(appendWorktreesEntry('node_modules/')).toBe('node_modules/\n.worktrees/\n')
  })

  it('does not add a duplicate newline when prior content ends with one', () => {
    expect(appendWorktreesEntry('node_modules/\n')).toBe('node_modules/\n.worktrees/\n')
  })
})
