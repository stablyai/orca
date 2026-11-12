import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('electron', () => ({ app: { getPath: () => state.home } }))
import { ClaudeHookService } from './hook-service'
import { provisionClaudeProfile } from '../claude-accounts/profiles/setup/claude-profile-provisioning'

const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-case-probe-'))
  try {
    mkdirSync(join(dir, 'probe'))
    return existsSync(join(dir, 'PROBE'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const CURRENT = { claudeVersion: '2.1.261' }
function fixture() {
  state.home = mkdtempSync(join(tmpdir(), 'claude-profile-hooks-'))
  roots.push(state.home)
  const defaultDir = join(state.home, '.claude')
  const profile = join(state.home, 'profile')
  mkdirSync(defaultDir)
  mkdirSync(profile)
  const settings = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  const edit = (dir: string, change: (value: Record<string, unknown>) => void): void => {
    const value = settings(dir)
    change(value)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))
  }
  const service = new ClaudeHookService()
  const installProfile = () => service.install({ ...CURRENT, configDir: profile })
  const provision = () =>
    provisionClaudeProfile({ profileHome: profile, userHome: state.home, platform: 'linux' })
  return { defaultDir, profile, settings, edit, service, installProfile, provision }
}

// Symlink creation needs Windows privileges.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude hooks at an explicit profile', () => {
  itLinks('refuses a profile destination that is or links into the default home', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const defaults = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    rmSync(join(f.profile, 'settings.json'), { force: true })
    symlinkSync(join(f.defaultDir, 'settings.json'), join(f.profile, 'settings.json'))
    expect(f.installProfile().state).toBe('error')
    expect(f.service.install({ ...CURRENT, configDir: f.defaultDir }).state).toBe('error')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(defaults)
  })
  it.runIf(caseInsensitive)('refuses a case-only alias of the default home', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const defaults = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    const alias = join(state.home, '.CLAUDE')
    expect(f.service.install({ ...CURRENT, configDir: alias }).state).toBe('error')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(defaults)
  })
})
