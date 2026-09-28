import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectsRootDirs, ompSessionsRootDirs } from './session-scanner-roots'

describe('ompSessionsRootDirs', () => {
  it('drops a degenerate root that would resolve to the process cwd', () => {
    // normalizeAgentSessionsDir('/') returns ''. Kept, that root would resolve()
    // to the cwd and allowlist it for renderer-supplied subagent paths.
    expect(ompSessionsRootDirs({ ompSessionsDir: '' })).toEqual([])
    expect(ompSessionsRootDirs({ ompSessionsDir: '   ' })).toEqual([])
  })

  it('keeps the host root and one root per distinct WSL distro home', () => {
    expect(
      ompSessionsRootDirs({
        ompSessionsDir: '/home/ada/.omp/agent/sessions',
        wslHomeDirs: ['/wsl/ubuntu/home/ada', '/wsl/ubuntu/home/ada', '  ']
      })
    ).toEqual([
      '/home/ada/.omp/agent/sessions',
      join('/wsl/ubuntu/home/ada', '.omp', 'agent', 'sessions')
    ])
  })
})

describe('claudeProjectsRootDirs', () => {
  it('includes additional Claude projects dirs after the primary root', () => {
    expect(
      claudeProjectsRootDirs({
        claudeProjectsDir: '/home/ada/.claude/projects',
        additionalClaudeProjectsDirs: [
          '/home/ada/.claude-work/projects',
          '/home/ada/.claude-personal/projects'
        ]
      })
    ).toEqual([
      '/home/ada/.claude/projects',
      '/home/ada/.claude-work/projects',
      '/home/ada/.claude-personal/projects'
    ])
  })

  it('drops blank and duplicate extras', () => {
    expect(
      claudeProjectsRootDirs({
        claudeProjectsDir: '/home/ada/.claude/projects',
        additionalClaudeProjectsDirs: [
          '/home/ada/.claude/projects',
          '   ',
          '/home/ada/.claude-work/projects'
        ]
      })
    ).toEqual(['/home/ada/.claude/projects', '/home/ada/.claude-work/projects'])
  })
})
