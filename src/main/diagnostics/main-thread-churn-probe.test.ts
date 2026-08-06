import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAIN_THREAD_DIAGNOSTICS_ENV,
  classifySubprocessCommand,
  drainSubprocessSpawnStats,
  isMainThreadDiagnosticsEnabled,
  recordSubprocessSpawn
} from './main-thread-churn-probe'

afterEach(() => {
  vi.unstubAllEnvs()
  drainSubprocessSpawnStats()
})

describe('classifySubprocessCommand', () => {
  it('uses the git subcommand, skipping global value flags', () => {
    expect(classifySubprocessCommand('git', ['-C', '/repo', 'status', '--porcelain=v2'])).toBe(
      'git status'
    )
    expect(
      classifySubprocessCommand('git', ['-c', 'core.quotepath=off', 'rev-list', '--count'])
    ).toBe('git rev-list')
    expect(classifySubprocessCommand('git', ['--git-dir=/repo/.git', 'log', '--oneline'])).toBe(
      'git log'
    )
  })

  it('normalizes absolute paths and .exe suffixes', () => {
    expect(classifySubprocessCommand('/usr/bin/git', ['status'])).toBe('git status')
    expect(classifySubprocessCommand('C:\\Program Files\\Git\\git.exe', ['fetch'])).toBe(
      'git fetch'
    )
    expect(classifySubprocessCommand('gh', ['api', 'rate_limit'])).toBe('gh api')
  })

  it('unwraps wsl.exe-routed commands', () => {
    expect(
      classifySubprocessCommand('wsl.exe', ['-d', 'Ubuntu', '--', 'git', 'status', '--porcelain'])
    ).toBe('git status')
    expect(classifySubprocessCommand('wsl.exe', ['-d', 'Ubuntu'])).toBe('wsl')
  })

  it('falls back to the binary name when no subcommand exists', () => {
    expect(classifySubprocessCommand('rg', ['--files'])).toBe('rg')
  })

  it('never treats positionals or git-flag values as subcommands for non-subcommand CLIs', () => {
    // rg's -C takes a number; it must not be consumed as a git-style flag
    // value, and "3"/"pattern" must not become fake subcommand buckets.
    expect(classifySubprocessCommand('rg', ['-C', '3', 'pattern'])).toBe('rg')
    expect(classifySubprocessCommand('node', ['script.js'])).toBe('node')
  })
})

describe('recordSubprocessSpawn', () => {
  it('is a no-op when the diagnostics env var is unset', () => {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '')
    expect(isMainThreadDiagnosticsEnabled()).toBe(false)
    recordSubprocessSpawn('git', ['status'], 1)
    expect(drainSubprocessSpawnStats()).toEqual({})
  })

  it('aggregates count and block time per command, and drain resets', () => {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '1')
    recordSubprocessSpawn('git', ['-C', '/repo', 'status'], 2)
    recordSubprocessSpawn('/usr/bin/git', ['status', '--porcelain=v2'], 4)
    recordSubprocessSpawn('git', ['rev-list', '--count'], 1.5)
    expect(drainSubprocessSpawnStats()).toEqual({
      'git status': { count: 2, blockMsTotal: 6, blockMsMax: 4 },
      'git rev-list': { count: 1, blockMsTotal: 1.5, blockMsMax: 1.5 }
    })
    expect(drainSubprocessSpawnStats()).toEqual({})
  })
})
