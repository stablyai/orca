import type * as NodeFsModule from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const state = vi.hoisted((): { home: string; syncCalls: { name: string; target: string }[] } => ({
  home: '',
  syncCalls: []
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const [name, value] of Object.entries(actual)) {
    if (!name.endsWith('Sync') || typeof value !== 'function') {
      continue
    }
    const original = value as ((...args: unknown[]) => unknown) & Record<string, unknown>
    const recorder = (...args: unknown[]): unknown => {
      state.syncCalls.push({ name, target: typeof args[0] === 'string' ? args[0] : '' })
      return original(...args)
    }
    Object.assign(recorder, original)
    wrapped[name] = recorder
  }
  return { ...wrapped, default: wrapped }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOsModule>()
  return { ...actual, default: actual, homedir: () => state.home }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS } from './managed-agent-hook-registry'
import { ClaudeAgentViewService } from '../claude/agent-view-service'
import { reconcileClaudeAgentViewConfig } from '../claude/agent-view-config'
import { ensureClaudeAgentViewPluginAsync } from '../claude/agent-view-plugin'
import { listClaudeProfileHomesAsync } from '../claude-accounts/claude-profile-homes'

function syncCallsUnderHome(): string[] {
  return state.syncCalls
    .filter((call) => call.target.startsWith(state.home))
    .map((call) => `${call.name}(${call.target})`)
}

describe('managed hook script refresh stays off the main thread', () => {
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'orca-hook-refresh-main-thread-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(state.home, '.claude'))
    installFakeAppEnvironment({ getPath: () => join(state.home, 'user-data') })
    vi.stubEnv('ORCA_USER_DATA_PATH', join(state.home, 'user-data'))
    vi.stubEnv('GROK_HOME', undefined)
    vi.stubEnv('KIMI_CODE_HOME', undefined)
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    state.syncCalls = []
  })

  afterEach(async () => {
    await rm(state.home, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('uses no synchronous HOME filesystem calls for missing or stale scripts', async () => {
    const hooksDir = join(state.home, '.orca', 'agent-hooks')
    const claudeScript = join(
      hooksDir,
      process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
    )
    await mkdir(hooksDir, { recursive: true })
    await writeFile(claudeScript, 'stale', 'utf-8')
    const legacyRoot = join(state.home, '.claude', 'skills', 'orca-agent-view')
    await mkdir(join(legacyRoot, '.claude-plugin'), { recursive: true })
    await mkdir(join(legacyRoot, 'hooks'))
    await writeFile(
      join(legacyRoot, '.claude-plugin', 'orca-managed.json'),
      '{"owner":"stablyai/orca/claude-agent-view"}'
    )
    const modScript = join(
      state.home,
      '.claude',
      'skills',
      'orca-agent-view',
      'hooks',
      'register.js'
    )
    await writeFile(modScript, 'stale', 'utf8')
    const profileRoot = join(state.home, 'user-data', 'claude-profiles')
    const profileMods: string[] = []
    for (const id of ['first', 'second']) {
      const home = join(profileRoot, id, 'home')
      const legacyRoot = join(home, 'skills', 'orca-agent-view')
      await mkdir(join(legacyRoot, '.claude-plugin'), { recursive: true })
      await mkdir(join(legacyRoot, 'hooks'))
      await writeFile(
        join(legacyRoot, '.claude-plugin', 'orca-managed.json'),
        '{"owner":"stablyai/orca/claude-agent-view"}'
      )
      const mod = join(home, 'skills', 'orca-agent-view', 'hooks', 'register.js')
      await writeFile(mod, 'stale', 'utf8')
      profileMods.push(mod)
    }
    const absent = join(profileRoot, 'absent', 'home')
    await mkdir(absent, { recursive: true })
    const unowned = join(profileRoot, 'unowned', 'home', 'skills', 'orca-agent-view')
    await mkdir(join(unowned, '.claude-plugin'), { recursive: true })
    await mkdir(join(unowned, 'hooks'))
    await writeFile(join(unowned, '.claude-plugin', 'orca-managed.json'), '{"owner":"someone"}')
    await writeFile(join(unowned, 'hooks', 'register.js'), 'user-owned')
    state.syncCalls = []

    for (const [, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
      await refresh()
    }

    expect(syncCallsUnderHome()).toEqual([])
    const refreshed = await readFile(claudeScript, 'utf8')
    expect(refreshed).not.toBe('stale')
    expect(refreshed).toContain(process.platform === 'win32' ? 'echo {}' : 'printf "{}\\n"')
    await expect(readFile(modScript, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    for (const mod of profileMods) {
      await expect(readFile(mod, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(unowned, 'hooks', 'register.js'), 'utf8')).toBe('user-owned')
    await expect(
      readFile(join(absent, 'skills', 'orca-agent-view', 'hooks', 'register.js'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the Windows Claude entry and payload refresh off the main thread', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const hooksDir = join(state.home, '.orca', 'agent-hooks')
      await mkdir(hooksDir, { recursive: true })
      await writeFile(join(hooksDir, 'claude-hook.cmd'), 'stale', 'utf-8')
      state.syncCalls = []

      await MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS.find(([agent]) => agent === 'claude')![1]()

      expect(syncCallsUnderHome()).toEqual([])
      const entry = await readFile(join(hooksDir, 'claude-hook.cmd'), 'utf8')
      const payload = await readFile(join(hooksDir, 'claude-hook-impl.cmd'), 'utf8')
      expect(entry).toContain('set "ORCA_CLAUDE_HOOK_IMPL=%~dp0claude-hook-impl.cmd"')
      expect(payload).toContain('echo {}')
      expect(payload).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('prepares and disables navigation asynchronously and serves spawn cache reads without HOME I/O', async () => {
    const config = join(state.home, '.claude')
    const service = new ClaudeAgentViewService(join(state.home, 'user-data'), {
      reconcileConfig: reconcileClaudeAgentViewConfig,
      ensurePlugin: ensureClaudeAgentViewPluginAsync,
      listProfiles: listClaudeProfileHomesAsync,
      loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config })
    })
    await Promise.all(
      Array.from({ length: 100 }, () =>
        service.reconcile({ claudeSubagentNavigationEnabled: true })
      )
    )
    const root = service.read()?.pluginDir
    expect(root).toBeTruthy()
    expect(await readFile(join(root!, 'hooks', 'register.js'), 'utf8')).toContain('$.ui.view(')
    for (let pane = 0; pane < 100; pane++) {
      await service.ready()
      expect(service.read()?.pluginDir).toBe(root)
    }
    await Promise.all(
      Array.from({ length: 100 }, () =>
        service.reconcile({ claudeSubagentNavigationEnabled: false })
      )
    )
    expect(JSON.parse(await readFile(join(config, 'keybindings.json'), 'utf8')).bindings).toEqual(
      []
    )
    expect(service.read()).toBeUndefined()
    expect(syncCallsUnderHome()).toEqual([])
  })
})
