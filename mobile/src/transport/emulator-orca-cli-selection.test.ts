import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEmulatorOrcaArgs,
  emulatorWorktreeSelector,
  resolveEmulatorOrcaCli
} from '../../scripts/emulator-orca-cli-selection.mjs'

const devCli = (...parts: string[]) => path.resolve(...parts, 'config', 'scripts', 'orca-dev.mjs')

describe('resolveEmulatorOrcaCli', () => {
  it('honors explicit and managed CLI commands before filesystem discovery', () => {
    const pathExists = () => true

    expect(
      resolveEmulatorOrcaCli({
        explicitCommand: '/custom/orca',
        managedCommand: 'orca-dev',
        worktree: '/repo/worktree',
        cwd: '/repo/worktree/mobile',
        pathExists
      })
    ).toEqual({ command: '/custom/orca', source: 'ORCA_CLI override' })

    expect(
      resolveEmulatorOrcaCli({
        managedCommand: 'orca-dev',
        worktree: '/repo/worktree',
        cwd: '/repo/worktree/mobile',
        pathExists
      })
    ).toEqual({ command: 'orca-dev', source: 'managed Orca terminal' })
  })

  it('selects the explicit worktree wrapper before an unrelated dev root', () => {
    const expected = devCli('/repo/worktree')
    const pathExists = (candidate: string) => candidate === expected

    expect(
      resolveEmulatorOrcaCli({
        worktree: '/repo/worktree',
        devRepoRoot: '/repo/main',
        cwd: '/other',
        pathExists
      })
    ).toEqual({ command: expected, source: 'worktree dev wrapper' })
  })

  it('finds the nearest wrapper when launched from the mobile directory', () => {
    const expected = devCli('/repo/worktree')
    const pathExists = (candidate: string) => candidate === expected

    expect(
      resolveEmulatorOrcaCli({
        cwd: '/repo/worktree/mobile/src',
        pathExists
      })
    ).toEqual({ command: expected, source: 'nearest dev wrapper' })
  })

  it('uses platform-safe installed fallbacks only when no dev CLI exists', () => {
    const pathExists = () => false
    expect(resolveEmulatorOrcaCli({ cwd: '/repo', platform: 'darwin', pathExists })).toEqual({
      command: 'orca',
      source: 'installed Orca fallback'
    })
    expect(resolveEmulatorOrcaCli({ cwd: '/repo', platform: 'linux', pathExists })).toEqual({
      command: 'orca-ide',
      source: 'installed Orca fallback'
    })
  })
})

describe('emulatorWorktreeSelector', () => {
  it('uses an explicit path selector so absolute paths are not fuzzy-matched', () => {
    expect(emulatorWorktreeSelector('/repo/worktree')).toBe(
      `path:${path.resolve('/repo/worktree')}`
    )
  })

  it('builds scoped JSON command arguments', () => {
    expect(buildEmulatorOrcaArgs('tap', ['0.5', '0.6'], '/repo/worktree')).toEqual([
      'emulator',
      'tap',
      '0.5',
      '0.6',
      '--worktree',
      `path:${path.resolve('/repo/worktree')}`,
      '--json'
    ])
  })
})
