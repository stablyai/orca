import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'

const mocks = vi.hoisted(() => ({ localCheck: vi.fn() }))

vi.mock('../git/check-ignored-paths', () => ({ checkIgnoredPaths: mocks.localCheck }))

describe('local issue command runtime routing', () => {
  it.each(['command', ' '])(
    'preserves local file writes with an unavailable runtime: %j',
    async (content) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-runtime-ignore-'))
      const repo = {
        id: 'repo-1',
        path: root,
        displayName: 'local',
        badgeColor: '#000',
        addedAt: 0
      }
      mkdirSync(join(root, '.orca'))
      writeFileSync(join(root, '.orca', 'issue-command'), 'old command\n')
      const getLocalGitArgs = vi.fn((): [] => {
        throw new Error('Project runtime requires repair')
      })
      const commands = new RuntimeRepositoryIssueCommand({
        resolveRepo: async () => repo,
        getLocalGitArgs
      })
      try {
        await commands.write(repo.id, content)
        if (content.trim()) {
          expect(readFileSync(join(root, '.orca', 'issue-command'), 'utf8')).toBe('command\n')
          expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.orca\n')
        } else {
          expect(existsSync(join(root, '.orca', 'issue-command'))).toBe(false)
          expect(existsSync(join(root, '.gitignore'))).toBe(false)
          expect(getLocalGitArgs).not.toHaveBeenCalled()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
