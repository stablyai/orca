import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAgentViewService } from './agent-view-service'
import { reconcileClaudeAgentViewConfig } from './agent-view-config'
import { ensureClaudeAgentViewPluginAsync } from './agent-view-plugin'
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

it('prepares navigation by default and respects removed shortcuts after reenabling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-service-'))
  roots.push(root)
  const config = join(root, 'default')
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  const profile = join(root, 'account')
  const service = new ClaudeAgentViewService(join(root, 'orca'), {
    reconcileConfig: reconcileClaudeAgentViewConfig,
    ensurePlugin: ensureClaudeAgentViewPluginAsync,
    listProfiles: async () => [profile],
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
    claudeOnPath: async () => true
  })

  await Promise.all([service.reconcile({}), service.reconcile({})])
  const prepared = service.read(config)
  expect(prepared).toMatchObject({ configDir: config })
  expect(
    JSON.parse(await readFile(join(prepared!.pluginDir, 'hooks', 'hooks.json'), 'utf8'))
  ).toEqual({ modules: ['./register.js'] })
  expect(claudeAgentViewChord(await readFile(join(profile, 'keybindings.json'), 'utf8'))).toBe(
    'ctrl+alt+g'
  )
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

  await service.reconcile({ claudeSubagentNavigationEnabled: true })
  expect(claudeAgentViewChord(await readFile(join(config, 'keybindings.json'), 'utf8'))).toBe(
    'ctrl+alt+g'
  )
  expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}')
  await service.prepareProfile(join(root, 'new-account'))
  expect(
    claudeAgentViewChord(await readFile(join(root, 'new-account', 'keybindings.json'), 'utf8'))
  ).toBe('ctrl+alt+g')
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
    loginEnv,
    claudeOnPath: async () => true
  })
  await service.reconcile({ claudeSubagentNavigationEnabled: false })
  expect(claudeAgentViewChord(await readFile(bindings, 'utf8'))).toBeUndefined()
  expect(JSON.parse(await readFile(join(cachedConfig, 'orca-agent-view.json'), 'utf8')).setup).toBe(
    'pending'
  )
  expect(loginEnv.mock.calls).toEqual([[{ cachedOnly: true }]])
  expect(spawner).toHaveBeenCalledOnce()
})

it('leaves Claude config untouched when the Claude CLI is not on PATH (#43445)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-no-claude-'))
  roots.push(root)
  const config = join(root, 'claude')
  const service = new ClaudeAgentViewService(join(root, 'orca'), {
    reconcileConfig: reconcileClaudeAgentViewConfig,
    ensurePlugin: ensureClaudeAgentViewPluginAsync,
    listProfiles: async () => [join(root, 'account')],
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config }),
    claudeOnPath: async () => false
  })
  await service.reconcile({})
  await service.prepareProfile(join(root, 'new-account'))

  await expect(readFile(join(config, 'keybindings.json'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(config, 'orca-agent-view.json'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(root, 'new-account', 'keybindings.json'), 'utf8')).rejects.toThrow()
})
