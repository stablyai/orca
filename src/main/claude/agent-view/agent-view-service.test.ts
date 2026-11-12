import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAgentViewService } from './agent-view-service'
import { reconcileClaudeAgentViewConfig } from './agent-view-config'
import { ensureClaudeAgentViewPlugin, ensureClaudeAgentViewPluginAsync } from './agent-view-plugin'
import { claudeAgentViewChord } from './agent-view-keybindings'
import {
  captureLoginShellEnvironment,
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from '../../startup/shell-environment/login-shell-environment'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
  vi.useRealTimers()
  resetLoginShellEnvironmentCacheForTests()
})

it.each([{}, { claudeSubagentNavigationEnabled: true }])(
  'prepares navigation automatically, serializing config changes and respecting shortcut removals: %j',
  async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-service-'))
    roots.push(root)
    const config = join(root, 'default')
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    const profile = join(root, 'account')
    const reconcileConfig = vi.fn(reconcileClaudeAgentViewConfig)
    const ensurePlugin = vi.fn(ensureClaudeAgentViewPluginAsync)
    const service = new ClaudeAgentViewService(join(root, 'orca'), {
      reconcileConfig,
      ensurePlugin,
      listProfiles: async () => [profile],
      loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config })
    })
    await Promise.all(Array.from({ length: 100 }, () => service.reconcile(enabled)))
    expect(reconcileConfig).toHaveBeenCalledTimes(2)
    expect(ensurePlugin).toHaveBeenCalledOnce()
    expect(service.read(config)?.pluginDir).toBeTruthy()
    expect(service.read(config)?.pluginDir).toBe(ensureClaudeAgentViewPlugin(join(root, 'orca')))
    await writeFile(join(profile, 'keybindings.json'), '{"bindings":[]}')
    await service.reconcile({ claudeSubagentNavigationEnabled: false })
    expect(service.read(config)).toBeUndefined()
    expect(
      claudeAgentViewChord(await readFile(join(config, 'keybindings.json'), 'utf8'))
    ).toBeUndefined()
    expect(JSON.parse(await readFile(join(config, 'orca-agent-view.json'), 'utf8')).setup).toBe(
      'pending'
    )
    expect(JSON.parse(await readFile(join(profile, 'orca-agent-view.json'), 'utf8')).setup).toBe(
      'attempted'
    )
    await reconcileClaudeAgentViewConfig(join(config, 'settings.json'), false)
    await service.reconcile(enabled)
    expect(claudeAgentViewChord(await readFile(join(config, 'keybindings.json'), 'utf8'))).toBe(
      'ctrl+alt+g'
    )
    expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}')
    const calls = reconcileConfig.mock.calls.length
    for (let pane = 0; pane < 100; pane++) {
      service.read(config)
    }
    expect(reconcileConfig).toHaveBeenCalledTimes(calls)
    await service.prepareProfile(join(root, 'new-account'))
    expect(
      claudeAgentViewChord(await readFile(join(root, 'new-account', 'keybindings.json'), 'utf8'))
    ).toBe('ctrl+alt+g')
    await service.prepareProfile(join(root, 'new-account'))
    expect(reconcileConfig).toHaveBeenCalledTimes(calls + 1)
  }
)

it('cleans an owned shortcut in a cached login-shell config on a fresh disabled service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-cached-home-'))
  roots.push(root)
  const config = join(root, 'process-config')
  const cachedConfig = join(root, 'shell-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  const spawner = vi.fn(async () => ({ CLAUDE_CONFIG_DIR: cachedConfig }))
  await captureLoginShellEnvironment({ spawner })
  await reconcileClaudeAgentViewConfig(join(cachedConfig, 'settings.json'), true)
  const bindings = join(cachedConfig, 'keybindings.json')
  expect(claudeAgentViewChord(await readFile(bindings, 'utf8'))).toBe('ctrl+alt+g')
  const loginEnv = vi.fn(resolveLoginShellEnvironment)
  const service = new ClaudeAgentViewService(join(root, 'orca'), {
    reconcileConfig: reconcileClaudeAgentViewConfig,
    ensurePlugin: ensureClaudeAgentViewPluginAsync,
    listProfiles: async () => [],
    loginEnv
  })
  await service.reconcile({ claudeSubagentNavigationEnabled: false })
  expect(claudeAgentViewChord(await readFile(bindings, 'utf8'))).toBeUndefined()
  expect(JSON.parse(await readFile(join(cachedConfig, 'orca-agent-view.json'), 'utf8')).setup).toBe(
    'pending'
  )
  expect(loginEnv.mock.calls).toEqual([[{ cachedOnly: true }]])
  expect(spawner).toHaveBeenCalledOnce()
})
