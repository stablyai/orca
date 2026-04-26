import { mkdtemp, readFile as fsReadFile, writeFile as fsWriteFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join as pathJoin } from 'path'
import { describe, expect, it } from 'vitest'
import {
  isWorktreesDirIgnoredByGitignore,
  appendWorktreesEntry,
  readGitignore,
  isWorktreesDirIgnored,
  addWorktreesDirToGitignore
} from './gitignore'

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

describe('readGitignore', () => {
  it('returns the file contents when .gitignore exists', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
      expect(await readGitignore(dir)).toBe('node_modules/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null when .gitignore does not exist', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      expect(await readGitignore(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isWorktreesDirIgnored', () => {
  it('returns true when the file contains .worktrees/', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), '.worktrees/\n', 'utf-8')
      expect(await isWorktreesDirIgnored(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns false when the file is missing', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      expect(await isWorktreesDirIgnored(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('addWorktreesDirToGitignore', () => {
  it('creates .gitignore with the entry when missing', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('appends the entry to an existing .gitignore', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules/\n.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent — does not duplicate when entry already present', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n.worktrees/\n', 'utf-8')
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules/\n.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
