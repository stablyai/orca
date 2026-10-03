import { homedir } from 'node:os'
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
  it('searches the CLAUDE_CONFIG_DIR root first and keeps the default (#23505)', () => {
    expect(
      claudeProjectsRootDirs({
        env: { CLAUDE_CONFIG_DIR: '/home/ada/.claude-work' },
        wslHomeDirs: ['/wsl/ubuntu/home/ada']
      })
    ).toEqual([
      '/home/ada/.claude-work/projects',
      join(homedir(), '.claude', 'projects'),
      join('/wsl/ubuntu/home/ada', '.claude', 'projects')
    ])
  })

  it('collapses to one host root when the config dir is the default', () => {
    expect(
      claudeProjectsRootDirs({ env: { CLAUDE_CONFIG_DIR: join(homedir(), '.claude') } })
    ).toEqual([join(homedir(), '.claude', 'projects')])
  })

  it('uses only ~/.claude/projects when the override is unset or blank', () => {
    const hostRoot = join(homedir(), '.claude', 'projects')
    expect(claudeProjectsRootDirs({ env: {} })).toEqual([hostRoot])
    expect(claudeProjectsRootDirs({ env: { CLAUDE_CONFIG_DIR: '   ' } })).toEqual([hostRoot])
  })

  it('lets an explicit claudeProjectsDir replace the host roots, as before', () => {
    expect(
      claudeProjectsRootDirs({
        claudeProjectsDir: '/explicit/projects',
        env: { CLAUDE_CONFIG_DIR: '/home/ada/.claude-work' }
      })
    ).toEqual(['/explicit/projects'])
  })
})
