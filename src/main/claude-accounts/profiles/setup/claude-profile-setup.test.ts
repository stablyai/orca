import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import type * as SecureFile from '../../../../shared/secure-storage/secure-file'
const state = vi.hoisted(() => ({ home: '', canProtect: true }))
vi.mock('../../../../shared/secure-storage/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) =>
      actual.writeSecureFile(...args) && state.canProtect
  }
})
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('electron', () => ({ app: { getPath: () => state.home } }))

import { ClaudeHookService } from '../../../claude/hook-service'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from '../claude-profile-paths'
import { writeClaudeApiEndpoint } from './claude-api-endpoint'
import { provisionClaudeAccountProfile } from './claude-profile-setup'

const roots: string[] = []
afterEach(() => {
  state.canProtect = true
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const local = { runtime: 'host', executionHostId: 'local' } as const
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profile-setup-')))
  roots.push(root)
  state.home = join(root, 'home')
  const defaultHome = join(state.home, '.claude')
  const dataRoot = join(root, 'data')
  mkdirSync(defaultHome, { recursive: true })
  mkdirSync(dataRoot)
  const service = new ClaudeHookService()
  const installHooks = (target: { configDir: string }) =>
    service.install({ claudeVersion: '2.1.261', ...target })
  const setup = () =>
    provisionClaudeAccountProfile({
      dataRoot,
      profile: describeClaudeProfile(dataRoot, 'a', local),
      userHome: state.home,
      installHooks,
      platform: 'linux'
    })
  return { root, defaultHome, dataRoot, service, installHooks, setup }
}

// Linux-mode setup creates symlinks that require additional privileges on Windows.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude account profile setup', () => {
  itLinks('shares plugins Claude wrote into the folder before its first setup', async () => {
    const f = fixture()
    mkdirSync(join(f.defaultHome, 'plugins'))
    writeFileSync(join(f.defaultHome, 'plugins', 'installed_plugins.json'), '{"mine":true}')
    const home = join(f.dataRoot, 'claude-profiles/a/home')
    // A pane's `claude` read the pointer before setup ran and made its own registry.
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{}}')
    writeFileSync(join(home, 'plugins', 'claude-only.json'), '{}')
    const report = await f.setup()
    expect(report.surfaces.plugins).toBe('linked')
    expect(realpathSync(join(home, 'plugins'))).toBe(realpathSync(join(f.defaultHome, 'plugins')))
    expect(readFileSync(join(f.defaultHome, 'plugins', 'installed_plugins.json'), 'utf8')).toBe(
      '{"mine":true}'
    )
    expect(existsSync(join(f.defaultHome, 'plugins', 'claude-only.json'))).toBe(true)
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'plugins', code: 'retained-conflict' })
    )
    // After setup, a folder the user put in place of the link stays theirs.
    rmSync(join(home, 'plugins'))
    mkdirSync(join(home, 'plugins'))
    writeFileSync(join(home, 'plugins', 'own.json'), '{}')
    expect((await f.setup()).surfaces.plugins).toBe('user-owned')
  })
  itLinks('rebuilds a missing home without marking it set up before its last step', async () => {
    const f = fixture()
    const profile = describeClaudeProfile(f.dataRoot, 'a', local)
    const marker = join(f.dataRoot, 'claude-profiles/a/profile.json')
    prepareClaudeProfileDirectory(f.dataRoot, profile, state.home)()
    rmSync(profile.home, { recursive: true })
    mkdirSync(join(f.defaultHome, 'plugins'))
    let markedDuringHooks: boolean | undefined
    const pending = provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: (target) => {
        markedDuringHooks = existsSync(marker)
        return f.installHooks(target)
      },
      platform: 'linux'
    })
    // A running Claude may create its registry while history sharing is finishing.
    mkdirSync(join(profile.home, 'plugins'))
    writeFileSync(join(profile.home, 'plugins', 'claude-only.json'), '{}')
    const report = await pending
    expect(report.outcome).toBe('prepared')
    expect(markedDuringHooks).toBe(false)
    expect(realpathSync(join(profile.home, 'plugins'))).toBe(
      realpathSync(join(f.defaultHome, 'plugins'))
    )
    expect(readFileSync(join(f.defaultHome, 'plugins', 'claude-only.json'), 'utf8')).toBe('{}')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      version: 1,
      accountId: 'a',
      runtime: 'host'
    })
  })
})

describe('Claude endpoint account setup', () => {
  function endpointFixture() {
    const f = fixture()
    const profile = describeClaudeProfile(f.dataRoot, 'a', local)
    mkdirSync(profile.home, { recursive: true })
    writeClaudeApiEndpoint(profile.home, {
      label: 'Endpoint',
      baseUrl: 'https://api.example.test',
      authToken: 'endpoint-token',
      model: 'm',
      smallFastModel: 'm'
    })
    const settings = join(profile.home, 'settings.json')
    // Stands in for a hook installer that replaces settings.json with an unrestricted file.
    const installHooks = (): AgentHookInstallStatus => {
      const current = readFileSync(settings, 'utf8')
      rmSync(settings)
      writeFileSync(settings, current, { mode: 0o644 })
      return {
        agent: 'claude',
        state: 'installed',
        configPath: settings,
        managedHooksPresent: true,
        detail: null
      }
    }
    const setup = () =>
      provisionClaudeAccountProfile({
        dataRoot: f.dataRoot,
        profile,
        userHome: state.home,
        installHooks,
        platform: 'linux'
      })
    return { settings, setup }
  }

  it.skipIf(process.platform === 'win32')(
    'restricts settings.json again after hooks replace it',
    async () => {
      const f = endpointFixture()
      const report = await f.setup()
      expect(report.surfaces.hooks).toBe('merged')
      expect(readFileSync(f.settings, 'utf8')).toContain('endpoint-token')
      expect(statSync(f.settings).mode & 0o777).toBe(0o600)
    }
  )

  it('removes settings.json when it cannot be restricted after hooks', async () => {
    const f = endpointFixture()
    await f.setup()
    state.canProtect = false
    const report = await f.setup()
    expect(report.surfaces.hooks).toBe('failed')
    expect(existsSync(f.settings)).toBe(false)
  })
})
