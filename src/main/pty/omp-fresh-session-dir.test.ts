import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORCA_OMP_FORCE_NEW_SESSION_ENV,
  ORCA_OMP_FRESH_SESSION_DIR_ENV
} from '../../shared/omp-fresh-session-env'
import { applyOmpFreshSessionDirEnv } from './omp-fresh-session-dir'

describe('applyOmpFreshSessionDirEnv', () => {
  it('derives a stable source-agent session directory per worktree and separates worktrees', () => {
    const sourceAgentDir = join(tmpdir(), 'orca-omp-source-agent')
    const firstLaunchEnv = {
      ORCA_OMP_SOURCE_AGENT_DIR: sourceAgentDir,
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1'
    }
    const secondLaunchEnv = {
      ORCA_OMP_SOURCE_AGENT_DIR: sourceAgentDir,
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1'
    }
    const otherWorktreeEnv = {
      ORCA_OMP_SOURCE_AGENT_DIR: sourceAgentDir,
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1'
    }

    applyOmpFreshSessionDirEnv(firstLaunchEnv, { worktreeId: 'repo-1:feature-a', cwd: '/repo/a' })
    applyOmpFreshSessionDirEnv(secondLaunchEnv, { worktreeId: 'repo-1:feature-a', cwd: '/repo/a' })
    applyOmpFreshSessionDirEnv(otherWorktreeEnv, { worktreeId: 'repo-1:feature-b', cwd: '/repo/b' })

    expect(firstLaunchEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]).toBe(
      secondLaunchEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]
    )
    expect(firstLaunchEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]).not.toBe(
      otherWorktreeEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]
    )
    expect(
      firstLaunchEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]?.startsWith(
        `${join(sourceAgentDir, 'sessions', 'orca-worktrees')}${sep}`
      )
    ).toBe(true)
    expect(firstLaunchEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]?.split(sep).at(-1)).toMatch(
      /^[0-9a-f]{16}$/
    )
  })

  it('keeps omitted scope in the explicit unknown-worktree fallback bucket', () => {
    const sourceAgentDir = join(tmpdir(), 'orca-omp-source-agent')
    const firstEnv = {
      ORCA_OMP_SOURCE_AGENT_DIR: sourceAgentDir,
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1'
    }
    const secondEnv = {
      ORCA_OMP_SOURCE_AGENT_DIR: sourceAgentDir,
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1'
    }

    applyOmpFreshSessionDirEnv(firstEnv, {})
    applyOmpFreshSessionDirEnv(secondEnv, { worktreeId: '', cwd: '' })

    expect(firstEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]).toBe(secondEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV])
    expect(firstEnv[ORCA_OMP_FRESH_SESSION_DIR_ENV]?.split(sep).at(-1)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('keeps an explicit fresh session directory instead of replacing it', () => {
    const explicitFreshSessionDir = join(tmpdir(), 'explicit-omp-sessions')
    const env = {
      ORCA_OMP_SOURCE_AGENT_DIR: join(tmpdir(), 'orca-omp-source-agent'),
      [ORCA_OMP_FORCE_NEW_SESSION_ENV]: '1',
      [ORCA_OMP_FRESH_SESSION_DIR_ENV]: explicitFreshSessionDir
    }

    applyOmpFreshSessionDirEnv(env, { worktreeId: 'repo-1:feature-a', cwd: '/repo/a' })

    expect(env[ORCA_OMP_FRESH_SESSION_DIR_ENV]).toBe(explicitFreshSessionDir)
  })
})
