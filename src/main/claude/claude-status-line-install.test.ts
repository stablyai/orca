import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from './hook-service'

const USER_STATUS_LINE = { type: 'command', command: '/usr/local/bin/my-statusline' }

describe('Claude statusLine by resolved version', () => {
  let tmpHome: string
  let settingsPath: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-version-'))
    settingsPath = join(tmpHome, '.claude', 'settings.json')
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpHome, { recursive: true, force: true })
  })

  const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf-8'))

  it('writes no statusLine for a Claude whose settings schema rejects it', () => {
    new ClaudeHookService().install({ claudeVersion: '1.0.63' })
    expect(readSettings().statusLine).toBeUndefined()
    expect(readSettings().hooks.SessionStart).toBeDefined()
  })

  it('removes Orca statusLine on a downgrade and re-adds it after the upgrade', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.261' })
    expect(readSettings().statusLine?.command).toContain('claude-statusline')

    service.install({ claudeVersion: '1.0.63' })
    expect(readSettings().statusLine).toBeUndefined()

    // Why: Orca's own removal must not read as the user's opt-out on the next capable install.
    service.install({ claudeVersion: '1.0.64' })
    expect(readSettings().statusLine?.command).toContain('claude-statusline')
  })

  it('keeps the user opt-out across a downgrade and upgrade', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.261' })
    const { statusLine: _optedOut, ...rest } = readSettings()
    writeFileSync(settingsPath, JSON.stringify(rest))

    service.install({ claudeVersion: '1.0.63' })
    service.install({ claudeVersion: '2.1.261' })
    expect(readSettings().statusLine).toBeUndefined()
  })

  it('never removes a user statusLine for an old Claude', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ statusLine: USER_STATUS_LINE }))
    new ClaudeHookService().install({ claudeVersion: '1.0.63' })
    expect(readSettings().statusLine).toEqual(USER_STATUS_LINE)
  })

  it('keeps installing the statusLine when the version is unresolved', () => {
    new ClaudeHookService().install()
    expect(readSettings().statusLine?.command).toContain('claude-statusline')
  })
})
