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
} from '../startup/login-shell-environment'

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

it.each(['edited', 'reused', 'malformed'] as const)(
  'preserves user bindings through disabling and restart: %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-disable-'))
    roots.push(root)
    const settings = join(root, 'settings.json')
    const bindings = join(root, 'keybindings.json')
    await reconcileClaudeAgentViewConfig(settings, true)
    const original =
      kind === 'malformed'
        ? '{broken'
        : JSON.stringify({
            bindings: [
              {
                context: 'Chat',
                bindings: {
                  [kind === 'edited' ? 'ctrl+x' : 'ctrl+alt+g']:
                    kind === 'edited' ? 'command:orca-agent-view' : 'command:user'
                }
              }
            ]
          })
    await writeFile(bindings, original)
    await reconcileClaudeAgentViewConfig(settings, false)
    expect(await readFile(bindings, 'utf8')).toBe(original)
    if (kind === 'malformed') {
      await writeFile(
        bindings,
        '{ // repaired\n "bindings": [{"context":"Chat", "bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}'
      )
      await reconcileClaudeAgentViewConfig(settings, false)
      expect(claudeAgentViewChord(await readFile(bindings, 'utf8'))).toBeUndefined()
    }
    await reconcileClaudeAgentViewConfig(settings, true)
    const restored = await readFile(bindings, 'utf8')
    if (kind === 'malformed') {
      expect(restored).toContain('// repaired')
      expect(claudeAgentViewChord(restored)).toBe('ctrl+alt+g')
    } else {
      expect(restored).toBe(original)
    }
  }
)

it('keeps reconciliation ordered and prevents a stale enable from republishing its plugin root', async () => {
  const config = join(tmpdir(), 'orca-agent-view-ordered-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  const userData = join(tmpdir(), 'orca-agent-view-ordered-data')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reconcileConfig = vi.fn(async () => {
    await gate
  })
  const service = new ClaudeAgentViewService(userData, {
    reconcileConfig,
    ensurePlugin: async () => join(userData, 'plugin'),
    listProfiles: async () => [],
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config })
  })
  const first = service.reconcile({ claudeSubagentNavigationEnabled: true })
  await vi.waitFor(() => expect(reconcileConfig).toHaveBeenCalledOnce())
  const second = service.reconcile({ claudeSubagentNavigationEnabled: false })
  expect(service.read(config)).toBeUndefined()
  release()
  await Promise.all([first, second])
  expect(reconcileConfig.mock.calls).toEqual([
    [join(config, 'settings.json'), true],
    [join(config, 'settings.json'), false]
  ])
  expect(service.read(config)).toBeUndefined()
})

it.each([
  { claudeSubagentNavigationEnabled: false },
  { agentStatusHooksEnabled: false },
  { disabledTuiAgents: ['claude' as const] }
])('cleans disabled navigation without probing a login shell: %j', async (settings) => {
  const config = join(tmpdir(), 'orca-agent-view-disabled-config')
  const custom = join(tmpdir(), 'orca-agent-view-custom-config')
  const profile = join(tmpdir(), 'orca-agent-view-account-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  const loginEnv = vi.fn<typeof resolveLoginShellEnvironment>((options) =>
    options?.cachedOnly ? Promise.resolve({}) : new Promise<NodeJS.ProcessEnv>(() => {})
  )
  const reconcileConfig = vi.fn(async () => {})
  const ensurePlugin = vi.fn(async () => 'unused')
  const service = new ClaudeAgentViewService(join(tmpdir(), 'orca-agent-view-disabled-data'), {
    reconcileConfig,
    ensurePlugin,
    loginEnv,
    listProfiles: async () => [profile]
  })
  await service.reconcile({
    ...settings,
    agentDefaultEnv: { claude: { CLAUDE_CONFIG_DIR: custom } }
  })
  expect(loginEnv.mock.calls).toEqual([[{ cachedOnly: true }]])
  expect(ensurePlugin).not.toHaveBeenCalled()
  expect(reconcileConfig.mock.calls).toEqual(
    [config, custom, profile].map((dir) => [join(dir, 'settings.json'), false])
  )
})

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

it.each([
  { launchAgent: 'codex' as const, launchCommand: 'claude --resume' },
  { launchAgent: 'claude' as const, isWsl: true },
  { launchAgent: 'claude' as const, settings: { claudeSubagentNavigationEnabled: false } },
  {
    launchAgent: 'claude' as const,
    settings: { claudeSubagentNavigationEnabled: true, agentStatusHooksEnabled: false }
  },
  {
    launchAgent: 'claude' as const,
    settings: { claudeSubagentNavigationEnabled: true, disabledTuiAgents: ['claude' as const] }
  }
])('bypasses pending setup for an ineligible launch: %j', async (launch) => {
  vi.useFakeTimers()
  const config = join(tmpdir(), 'orca-agent-view-ineligible-config')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new ClaudeAgentViewService(join(tmpdir(), 'orca-agent-view-ineligible-data'), {
    reconcileConfig: () => gate,
    ensurePlugin: async () => join(tmpdir(), 'orca-agent-view-ineligible-plugin'),
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
    listProfiles: async () => []
  })
  const settings = { claudeSubagentNavigationEnabled: true }
  let reconciled = false
  const reconcile = service.reconcile(settings).then(() => {
    reconciled = true
  })
  try {
    await service.readyForLaunch({ settings, ...launch })
    expect(reconciled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    release()
    await reconcile
  }
})

it.each([
  { launchAgent: 'claude' as const },
  { launchCommand: 'claude --resume' },
  { launchAgent: 'claude' as const, settings: { claudeSubagentNavigationEnabled: true } }
])('bounds an enabled Claude launch waiting on stalled setup: %j', async (launch) => {
  vi.useFakeTimers()
  const config = join(tmpdir(), 'orca-agent-view-stalled-config')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new ClaudeAgentViewService(join(tmpdir(), 'orca-agent-view-stalled-data'), {
    reconcileConfig: () => gate,
    ensurePlugin: async () => join(tmpdir(), 'orca-agent-view-stalled-plugin'),
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
    listProfiles: async () => []
  })
  const settings = {}
  const reconcile = service.reconcile(settings)
  let ready = false
  const wait = service.readyForLaunch({ settings, ...launch }).then(() => {
    ready = true
  })
  try {
    await vi.advanceTimersByTimeAsync(199)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await wait
    expect(service.read()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    release()
    await reconcile
  }
  expect(service.read()?.pluginDir).toBeTruthy()
})
