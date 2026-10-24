import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { applyClaudeRichOutputEnv } from './claude-rich-output'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-rich-conflicts-'))
  temporary.push(root)
  const configDir = join(root, 'selected-profile')
  const cwd = join(root, 'project')
  const bundle = join(root, 'bundle')
  const plugin = (directory: string, name: string) =>
    json(join(directory, '.claude-plugin', 'plugin.json'), { name })
  for (const name of ['reply-markdown', 'reply-media']) {
    plugin(join(bundle, name), name)
  }
  const env: Record<string, string> = {
    ORCA_CLAUDE_RICH_OUTPUT: '1',
    CLAUDE_CONFIG_DIR: configDir
  }
  const options = {
    isPackaged: true,
    userDataPath: root,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: false,
    launchAgent: 'claude' as const,
    cwd
  }
  const launch = async () => {
    await applyClaudeRichOutputEnv(env, options, [bundle])
    return (env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(delimiter).filter(Boolean)
  }
  return { root, configDir, cwd, bundle, plugin, env, launch }
}

describe('preserving execution-host Claude plugins', () => {
  it.each([true, false])(
    'preserves a marketplace module when enabled=%s, including an entry alias',
    async (enabled) => {
      const f = fixture()
      const installPath = join(f.root, 'marketplace', 'different-entry-name')
      f.plugin(installPath, 'reply-media')
      const installFile = join(f.configDir, 'plugins', 'installed_plugins.json')
      json(installFile, {
        version: 2,
        plugins: { 'pictures@user-market': [{ scope: 'user', installPath }] }
      })
      const settingsFile = join(f.configDir, 'settings.json')
      json(settingsFile, { enabledPlugins: { 'pictures@user-market': enabled } })
      const before = [readFileSync(installFile, 'utf8'), readFileSync(settingsFile, 'utf8')]
      expect(await f.launch()).toEqual([join(f.bundle, 'reply-markdown')])
      expect([readFileSync(installFile, 'utf8'), readFileSync(settingsFile, 'utf8')]).toEqual(
        before
      )
    }
  )

  it.each(['user', 'project'])('preserves a %s skills-directory module', async (scope) => {
    const f = fixture()
    const root = scope === 'user' ? f.configDir : join(f.cwd, '.claude')
    f.plugin(join(root, 'skills', 'custom-folder'), 'reply-markdown')
    expect(await f.launch()).toEqual([join(f.bundle, 'reply-media')])
  })

  it.each(['project', 'local'])('respects a %s install in a folder workspace', async (scope) => {
    const f = fixture()
    const installPath = join(f.root, 'marketplace', 'markup')
    f.plugin(installPath, 'reply-markdown')
    json(join(f.configDir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'markup@market': [{ scope, projectPath: f.cwd, installPath }] }
    })
    expect(await f.launch()).toEqual([join(f.bundle, 'reply-media')])
  })

  it('keeps a synced plugin without an install record', async () => {
    const f = fixture()
    f.plugin(join(f.configDir, 'plugins', 'synced', 'custom-id'), 'reply-media')
    expect(await f.launch()).toEqual([join(f.bundle, 'reply-markdown')])
  })

  it('honors a project-local disable and a declared install that has not been fetched', async () => {
    const f = fixture()
    json(join(f.configDir, 'settings.json'), { enabledPlugins: { 'reply-media@neoncoat': true } })
    json(join(f.cwd, '.claude', 'settings.local.json'), {
      enabledPlugins: { 'reply-media@neoncoat': false }
    })
    expect(await f.launch()).toEqual([join(f.bundle, 'reply-markdown')])
  })

  it('uses project install scope rather than a different project on the same host', async () => {
    const f = fixture()
    const installPath = join(f.root, 'marketplace', 'media')
    f.plugin(installPath, 'reply-media')
    json(join(f.configDir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'media@market': [{ scope: 'project', projectPath: join(f.root, 'elsewhere'), installPath }]
      }
    })
    expect(await f.launch()).toEqual([
      join(f.bundle, 'reply-markdown'),
      join(f.bundle, 'reply-media')
    ])
  })

  it('respects plugin paths supplied by Claude settings instead of overriding their environment', async () => {
    const f = fixture()
    json(join(f.configDir, 'settings.json'), {
      env: { CLAUDE_CODE_PLUGIN_DIRS: join(f.root, 'user-plugins') }
    })
    expect(await f.launch()).toEqual([])
    expect(f.env).not.toHaveProperty('CLAUDE_CODE_PLUGIN_DIRS')
  })

  it('does not guess through broken metadata or alter explicitly supplied paths', async () => {
    const f = fixture()
    const path = join(f.configDir, 'plugins', 'installed_plugins.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    f.env.CLAUDE_CODE_PLUGIN_DIRS = join(f.root, 'mine')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await f.launch()).toEqual([join(f.root, 'mine')])
    expect(f.env).not.toHaveProperty('ORCA_CLAUDE_PLUGIN_DIRS')
    expect(warning).toHaveBeenCalledOnce()
  })
})
