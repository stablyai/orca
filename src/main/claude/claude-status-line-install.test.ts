import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'

// When stubbing Windows, pair its platform with path.win32 basename behavior.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return {
    ...actual,
    basename: (...args: Parameters<typeof actual.basename>) =>
      (process.platform === 'win32' ? actual.win32 : actual).basename(...args)
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from './hook-service'
import { getManagedCommand } from './hook-settings'
import { getManagedStatusLineCommand } from './statusline-script'

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

describe('Claude statusLine on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const CURRENT_CLAUDE = { claudeVersion: '2.1.261' }
  let tmpHome: string
  let settingsPath: string
  let scriptPath: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-win-'))
    settingsPath = join(tmpHome, '.claude', 'settings.json')
    scriptPath = join(tmpHome, '.orca', 'agent-hooks', 'claude-statusline.cmd')
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.unstubAllEnvs()
    rmSync(tmpHome, { recursive: true, force: true })
  })

  const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const seedStatusLine = (command: string) => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command } }))
  }

  it('registers a cmd-safe script bare, which Windows PowerShell can run', () => {
    expect(
      getManagedStatusLineCommand('C:\\Users\\alice\\.orca\\agent-hooks\\claude-statusline.cmd')
    ).toBe('C:/Users/alice/.orca/agent-hooks/claude-statusline.cmd')
  })

  it('keeps the runtime-home form for an unsafe path rather than an encoded PowerShell launcher', () => {
    const spaced = 'C:\\Users\\John Smith\\.orca\\agent-hooks\\claude-statusline.cmd'
    expect(getManagedStatusLineCommand(spaced)).toBe(getManagedCommand(spaced))
  })

  it.each([
    ['the runtime-home form', () => getManagedCommand(scriptPath)],
    ['a stale bare path', () => 'C:/Users/someone-else/.orca/agent-hooks/claude-statusline.cmd']
  ])('replaces %s as Orca-owned', (_name, command) => {
    seedStatusLine(command())
    mkdirSync(join(tmpHome, '.orca', 'agent-hooks'), { recursive: true })
    writeFileSync(join(tmpHome, '.orca', 'agent-hooks', 'claude-statusline.installed'), '')

    new ClaudeHookService().install(CURRENT_CLAUDE)
    expect(readSettings().statusLine).toEqual({
      type: 'command',
      command: getManagedStatusLineCommand(scriptPath)
    })
  })

  it.each(['C:/tools/my-statusline.cmd', 'powershell -NoProfile -File C:\\tools\\statusline.ps1'])(
    'never overwrites or removes a user statusLine: %s',
    (command) => {
      seedStatusLine(command)
      new ClaudeHookService().install(CURRENT_CLAUDE)
      expect(readSettings().statusLine).toEqual({ type: 'command', command })
      new ClaudeHookService().remove()
      expect(readSettings().statusLine).toEqual({ type: 'command', command })
    }
  )
})
