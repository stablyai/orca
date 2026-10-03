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
  const provision = () => provisionClaudeProfile({ profileHome: profile, userHome: state.home })
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
const CUSTOM = { type: 'command', command: 'my-statusline' }
function statusLines(f: ReturnType<typeof fixture>) {
  const setDefaultCustom = () =>
    f.edit(f.defaultDir, (value) => {
      value.statusLine = CUSTOM
    })
  // The user drops their custom line and toggles Orca's hooks off and on again.
  const revertDefaultToOrca = () => {
    f.edit(f.defaultDir, (value) => delete value.statusLine)
    f.service.remove()
    f.service.install(CURRENT)
  }
  const sync = async () => {
    await f.provision()
    f.installProfile()
  }
  return { setDefaultCustom, revertDefaultToOrca, sync }
}

describe('Claude hooks at an explicit profile', () => {
  it('installs identical managed hooks at a profile without editing default settings', () => {
    const f = fixture()
    writeFileSync(join(f.defaultDir, 'settings.json'), '{"model":"default"}')
    writeFileSync(join(f.profile, 'settings.json'), '{"model":"profile"}')
    expect(f.service.install(CURRENT).state).toBe('installed')
    const before = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    const result = f.installProfile()
    expect(result.configPath).toBe(join(f.profile, 'settings.json'))
    expect(result.state).toBe('installed')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(before)
    const settings = f.settings(f.profile)
    expect(settings.model).toBe('profile')
    expect(settings.hooks).toEqual(JSON.parse(before).hooks)
    expect(settings.statusLine).toEqual(JSON.parse(before).statusLine)
  })
  it('retires only the profile statusline marker for an old Claude', () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(true)
    f.service.install({ claudeVersion: '1.0.0', configDir: f.profile })
    expect(f.settings(f.profile).statusLine).toBeUndefined()
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(false)
    expect(existsSync(join(state.home, '.orca/agent-hooks/claude-statusline.installed'))).toBe(true)
  })
  it('keeps a profile opt-out across re-provision and reinstall', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toEqual(f.settings(f.defaultDir).statusLine)
    f.edit(f.profile, (value) => delete value.statusLine)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toBeUndefined()
  })
  it('carries a default-home opt-out to every profile', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    f.edit(f.defaultDir, (value) => delete value.statusLine)
    f.service.install(CURRENT)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.defaultDir).statusLine).toBeUndefined()
    expect(f.settings(f.profile).statusLine).toBeUndefined()
  })
  it('shares a custom default statusline into a profile that had Orca line', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    const custom = { type: 'command', command: 'my-statusline' }
    f.edit(f.defaultDir, (value) => {
      value.statusLine = custom
    })
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toEqual(custom)
  })
  it("shares the user's own hooks around Orca's, keeping profile edits and never duplicating Orca's", async () => {
    const f = fixture()
    const { hook, setStop, stop, orcaCount } = stopHooks(f)
    f.service.install(CURRENT)
    setStop(f.defaultDir, ['notify-me', 'format-me'])
    await f.provision()
    f.installProfile()
    expect(stop(f.profile).slice(0, 2)).toEqual([hook('notify-me'), hook('format-me')])
    expect(orcaCount(f.profile)).toBe(1)
    setStop(f.defaultDir, ['notify-me'])
    await f.provision()
    // Orca's entry survives the merge before the installer runs again.
    expect(stop(f.profile)).toEqual([hook('notify-me'), expect.anything()])
    expect(orcaCount(f.profile)).toBe(1)
    f.installProfile()
    await f.provision()
    expect(stop(f.profile)[0]).toEqual(hook('notify-me'))
    expect(stop(f.profile)).toHaveLength(2)
    expect(orcaCount(f.profile)).toBe(1)
    setStop(f.profile, ['profile-only'])
    setStop(f.defaultDir, ['notify-v2'])
    await f.provision()
    f.installProfile()
    expect(stop(f.profile)[0]).toEqual(hook('profile-only'))
    expect(orcaCount(f.profile)).toBe(1)
  })
  it("removes the user's last hook from an unedited profile and keeps a profile-side deletion", async () => {
    const f = fixture()
    const { hook, setStop, stop, orcaCount } = stopHooks(f)
    f.service.install(CURRENT)
    setStop(f.defaultDir, ['notify-me'])
    await f.provision()
    f.installProfile()
    expect(stop(f.profile)[0]).toEqual(hook('notify-me'))
    setStop(f.defaultDir, [])
    await f.provision()
    expect(stop(f.profile)).not.toContainEqual(hook('notify-me'))
    expect(orcaCount(f.profile)).toBe(1)
    expect((await f.provision()).surfaces['settings.json']).toBe('unchanged')
    setStop(f.defaultDir, ['notify-me'])
    await f.provision()
    expect(stop(f.profile)[0]).toEqual(hook('notify-me'))
    setStop(f.profile, [])
    await f.provision()
    f.installProfile()
    expect(stop(f.profile)).not.toContainEqual(hook('notify-me'))
    expect(orcaCount(f.profile)).toBe(1)
  })
  it('lets a shared custom statusline follow the default back to none or to Orca line', async () => {
    const f = fixture()
    const { setDefaultCustom, revertDefaultToOrca, sync } = statusLines(f)
    f.service.install(CURRENT)
    setDefaultCustom()
    await sync()
    expect(f.settings(f.profile).statusLine).toEqual(CUSTOM)
    f.edit(f.defaultDir, (value) => delete value.statusLine)
    await sync()
    expect(f.settings(f.profile).statusLine).toBeUndefined()
    setDefaultCustom()
    await sync()
    revertDefaultToOrca()
    await sync()
    expect(f.settings(f.profile).statusLine).toEqual(f.settings(f.defaultDir).statusLine)
    expect(f.settings(f.profile).statusLine).not.toEqual(CUSTOM)
  })
  it('gives a profile Orca line back after a custom line replaced it, but keeps a profile opt-out', async () => {
    const f = fixture()
    const { setDefaultCustom, revertDefaultToOrca, sync } = statusLines(f)
    f.service.install(CURRENT)
    f.installProfile()
    setDefaultCustom()
    await sync()
    revertDefaultToOrca()
    await sync()
    expect(f.settings(f.profile).statusLine).toEqual(f.settings(f.defaultDir).statusLine)
    const optedOut = fixture()
    const opted = statusLines(optedOut)
    optedOut.service.install(CURRENT)
    optedOut.installProfile()
    optedOut.edit(optedOut.profile, (value) => delete value.statusLine)
    await opted.sync()
    opted.setDefaultCustom()
    await opted.sync()
    opted.revertDefaultToOrca()
    await opted.sync()
    expect(optedOut.settings(optedOut.profile).statusLine).toBeUndefined()
  })
  it('leaves the profile statusline alone while the default settings are unreadable', () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    const before = f.settings(f.profile).statusLine
    writeFileSync(join(f.defaultDir, 'settings.json'), '{bad')
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toEqual(before)
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(true)
  })
  it('refuses a profile destination that is or links into the default home', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const defaults = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    rmSync(join(f.profile, 'settings.json'), { force: true })
    symlinkSync(join(f.defaultDir, 'settings.json'), join(f.profile, 'settings.json'))
    expect(f.service.remove({ configDir: f.profile }).state).toBe('error')
    expect(f.installProfile().state).toBe('error')
    expect(f.service.install({ ...CURRENT, configDir: f.defaultDir }).state).toBe('error')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(defaults)
    expect(existsSync(join(f.defaultDir, '.orca-statusline.installed'))).toBe(false)
  })
  it.runIf(caseInsensitive)('refuses a case-only alias of the default home', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const defaults = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    const alias = join(state.home, '.CLAUDE')
    expect(f.service.install({ ...CURRENT, configDir: alias }).state).toBe('error')
    expect(f.service.remove({ configDir: alias }).state).toBe('error')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(defaults)
    expect(existsSync(join(f.defaultDir, '.orca-statusline.installed'))).toBe(false)
  })
  it("shares the user's first hook into a profile that so far holds only Orca's", async () => {
    const f = fixture()
    const { hook, setStop, stop } = stopHooks(f)
    writeFileSync(join(f.defaultDir, 'settings.json'), '{"model":"a"}')
    await f.provision()
    f.installProfile()
    f.service.install(CURRENT)
    setStop(f.defaultDir, ['my-guard'])
    await f.provision()
    expect(stop(f.profile)[0]).toEqual(hook('my-guard'))
  })
  it("removes the user's hooks but keeps Orca's when the whole hooks block leaves ~/.claude", async () => {
    const f = fixture()
    const { hook, setStop, stop, orcaCount } = stopHooks(f)
    f.service.install(CURRENT)
    setStop(f.defaultDir, ['my-guard'])
    await f.provision()
    f.installProfile()
    const orcaEvents = Object.keys(f.settings(f.profile).hooks ?? {})
    f.edit(f.defaultDir, (value) => delete value.hooks)
    expect((await f.provision()).surfaces['settings.json']).toBe('merged')
    expect(stop(f.profile)).not.toContainEqual(hook('my-guard'))
    expect(orcaCount(f.profile)).toBe(1)
    expect(Object.keys(f.settings(f.profile).hooks ?? {})).toEqual(orcaEvents)
    expect((await f.provision()).surfaces['settings.json']).toBe('unchanged')
  })
  it('creates the marker in a profile directory that did not exist yet', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const fresh = join(state.home, 'fresh')
    f.service.install({ ...CURRENT, configDir: fresh })
    expect(existsSync(join(fresh, '.orca-statusline.installed'))).toBe(true)
  })
  it('removes Orca hooks, statusline and marker from a profile only', () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    const before = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    expect(f.service.remove({ configDir: f.profile }).state).toBe('not_installed')
    expect(f.settings(f.profile)).toEqual({ hooks: {} })
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(false)
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(before)
    expect(f.service.getStatus(CURRENT).state).toBe('installed')
  })
  it('keeps profile destinations off the remote installer', () => {
    type RemoteOptions = Parameters<ClaudeHookService['installRemote']>[2]
    // @ts-expect-error -- remote settings live at the remote default home only
    const remote: RemoteOptions = { configDir: '/profile' }
    expect(remote).toBeDefined()
  })
})
