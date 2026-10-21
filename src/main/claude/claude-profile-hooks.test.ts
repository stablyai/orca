import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import { provisionClaudeProfile } from '../claude-accounts/claude-profile-provisioning'

// Case-only aliases exist only on a case-insensitive filesystem (default APFS, NTFS).
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

function stopHooks(f: ReturnType<typeof fixture>) {
  const hook = (command: string) => ({ matcher: '', hooks: [{ type: 'command', command }] })
  const stopOf = (value: Record<string, unknown>): unknown[] => {
    const hooks: unknown = value.hooks
    return hooks && typeof hooks === 'object' && 'Stop' in hooks && Array.isArray(hooks.Stop)
      ? hooks.Stop
      : []
  }
  const isOrca = (entry: unknown) => JSON.stringify(entry).includes('agent-hooks')
  const setStop = (dir: string, commands: string[]) =>
    f.edit(dir, (value) => {
      const hooks = typeof value.hooks === 'object' ? value.hooks : {}
      value.hooks = { ...hooks, Stop: [...commands.map(hook), ...stopOf(value).filter(isOrca)] }
    })
  const stop = (dir: string) => stopOf(f.settings(dir))
  const orcaCount = (dir: string) => stop(dir).filter(isOrca).length
  return { hook, setStop, stop, orcaCount }
}
const sync = async (f: ReturnType<typeof fixture>) => {
  const report = await f.provision()
  expect(f.installProfile().state).toBe('installed')
  return report
}

// Why: these create real symlinks, which Windows needs privilege for.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude hooks at an explicit profile', () => {
  it('installs managed hooks at a profile without editing default settings or adding a statusline', () => {
    const f = fixture()
    writeFileSync(join(f.defaultDir, 'settings.json'), '{"model":"default"}')
    writeFileSync(join(f.profile, 'settings.json'), '{"model":"profile"}')
    expect(f.service.install(CURRENT).state).toBe('installed')
    const before = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    const result = f.installProfile()
    expect(result.configPath).toBe(join(f.profile, 'settings.json'))
    expect(result.state).toBe('installed')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(before)
    expect(f.settings(f.profile)).toEqual({ model: 'profile', hooks: JSON.parse(before).hooks })
  })
  it("shares the user's hooks, Orca's hooks and statusline as plain keys that installs leave in sync", async () => {
    const f = fixture()
    const { hook, setStop, stop, orcaCount } = stopHooks(f)
    f.service.install(CURRENT)
    setStop(f.defaultDir, ['notify-me'])
    await sync(f)
    expect(f.settings(f.profile).hooks).toEqual(f.settings(f.defaultDir).hooks)
    expect(f.settings(f.profile).statusLine).toEqual(f.settings(f.defaultDir).statusLine)
    expect((await sync(f)).surfaces['settings.json']).toBe('unchanged')
    setStop(f.defaultDir, ['notify-v2'])
    await sync(f)
    expect(stop(f.profile)[0]).toEqual(hook('notify-v2'))
    expect(orcaCount(f.profile)).toBe(1)
    // The default home is the master copy: an edit made in the profile lasts until the next refresh.
    setStop(f.profile, ['profile-only'])
    setStop(f.defaultDir, ['notify-v3'])
    await sync(f)
    expect(stop(f.profile)[0]).toEqual(hook('notify-v3'))
    expect(orcaCount(f.profile)).toBe(1)
  })
  it.each(['with', 'without'])(
    'leaves the profile settings untouched by a refresh that changes nothing, %s Orca hooks in the default home',
    async (variant) => {
      const f = fixture()
      writeFileSync(join(f.defaultDir, 'settings.json'), JSON.stringify({ model: 'opus' }))
      if (variant === 'with') {
        f.service.install(CURRENT)
      }
      await sync(f)
      const file = join(f.profile, 'settings.json')
      const before = { text: readFileSync(file, 'utf8'), stat: statSync(file) }
      await sync(f)
      await sync(f)
      expect(readFileSync(file, 'utf8')).toBe(before.text)
      expect(statSync(file).mtimeMs).toBe(before.stat.mtimeMs)
      expect(statSync(file).ino).toBe(before.stat.ino)
    }
  )
  it('carries a default-home statusline opt-out and an old-Claude retire to the profile', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    await sync(f)
    expect(f.settings(f.profile).statusLine).toBeDefined()
    f.edit(f.defaultDir, (value) => delete value.statusLine)
    await sync(f)
    expect(f.settings(f.profile).statusLine).toBeUndefined()
    const old = fixture()
    old.service.install(CURRENT)
    await sync(old)
    old.service.install({ claudeVersion: '1.0.0' })
    await old.provision()
    old.service.install({ claudeVersion: '1.0.0', configDir: old.profile })
    expect(old.settings(old.defaultDir).statusLine).toBeUndefined()
    expect(old.settings(old.profile).statusLine).toBeUndefined()
  })
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
