import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'
import type * as GitBashModule from '../pty/shell-startup/git-bash'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

const { gitBashAvailableMock } = vi.hoisted(() => ({ gitBashAvailableMock: { value: true } }))
vi.mock('../pty/shell-startup/git-bash', async (importOriginal) => ({
  ...(await importOriginal<typeof GitBashModule>()),
  isGitBashAvailable: () => gitBashAvailableMock.value
}))

import { ClaudeHookService } from './hook-service'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }

describe('ClaudeHookService.install', () => {
  it('keeps newer Orca events and reports installed when a later probe cannot resolve the version', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-unknown-version-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const service = new ClaudeHookService()
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
      const known = JSON.parse(readFileSync(settingsPath, 'utf-8'))

      expect(service.install().state).toBe('installed')

      const unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(unknown.hooks).toEqual(known.hooks)
      expect(service.getStatus().state).toBe('installed')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not re-install a managed statusLine the user deleted, until remove() resets the opt-out', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-optout-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      delete settings.statusLine
      writeFileSync(settingsPath, JSON.stringify(settings))

      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined()

      new ClaudeHookService().remove()
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
