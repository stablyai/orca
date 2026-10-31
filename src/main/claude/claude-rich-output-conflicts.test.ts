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
  const launch = async (inheritedEnv: NodeJS.ProcessEnv = {}) => {
    await applyClaudeRichOutputEnv(env, options, [bundle], inheritedEnv)
    return (env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(delimiter).filter(Boolean)
  }
  return { root, configDir, cwd, bundle, plugin, env, launch }
}

describe('preserving execution-host Claude plugins', () => {
  it.each(
    ['', ' \t\n'].flatMap((content) =>
      ['profile settings', 'project settings', 'local settings', 'installed plugins'].map(
        (file) => ({ file, content })
      )
    )
  )('loads bundled modules with blank $file metadata: $content', async ({ file, content }) => {
    const f = fixture()
    const paths: Record<string, string> = {
      'profile settings': join(f.configDir, 'settings.json'),
      'project settings': join(f.cwd, '.claude', 'settings.json'),
      'local settings': join(f.cwd, '.claude', 'settings.local.json'),
      'installed plugins': join(f.configDir, 'plugins', 'installed_plugins.json')
    }
    const path = paths[file]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await f.launch()).toEqual([
      join(f.bundle, 'reply-markdown'),
      join(f.bundle, 'reply-media')
    ])
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(warning).not.toHaveBeenCalled()
  })

  it.each(
    ['', ' \t\n'].flatMap((content) =>
      ['configured', 'synced'].map((location) => ({ location, content }))
    )
  )(
    'preserves plugins with a blank $location manifest: $content',
    async ({ location, content }) => {
      const f = fixture()
      const directory =
        location === 'configured'
          ? join(f.root, 'custom-plugin')
          : join(f.configDir, 'plugins', 'synced', 'custom-plugin')
      const path = join(directory, '.claude-plugin', 'plugin.json')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      if (location === 'configured') {
        f.env.CLAUDE_CODE_PLUGIN_DIRS = directory
      }
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(await f.launch()).toEqual([
        ...(location === 'configured' ? [directory] : []),
        join(f.bundle, 'reply-markdown'),
        join(f.bundle, 'reply-media')
      ])
      expect(readFileSync(path, 'utf8')).toBe(content)
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it('checks the inherited daemon profile when the pane does not select one', async () => {
    const f = fixture()
    delete f.env.CLAUDE_CONFIG_DIR
    json(join(f.configDir, 'settings.json'), { enabledPlugins: { 'reply-media@neoncoat': false } })
    expect(await f.launch({ CLAUDE_CONFIG_DIR: f.configDir })).toEqual([
      join(f.bundle, 'reply-markdown')
    ])
  })

  it('keeps inherited daemon plugin paths and avoids injecting their second copy', async () => {
    const f = fixture()
    const userMarkdown = join(f.root, 'user-markdown')
    f.plugin(userMarkdown, 'reply-markdown')
    expect(await f.launch({ CLAUDE_CODE_PLUGIN_DIRS: userMarkdown })).toEqual([
      userMarkdown,
      join(f.bundle, 'reply-media')
    ])
  })

  it('lets explicit pane and account values override the daemon inheritance', async () => {
    const f = fixture()
    const inheritedProfile = join(f.root, 'inherited-profile')
    json(join(inheritedProfile, 'settings.json'), {
      enabledPlugins: { 'reply-media@neoncoat': false }
    })
    const inheritedMedia = join(f.root, 'inherited-media')
    f.plugin(inheritedMedia, 'reply-media')
    const explicitMarkdown = join(f.root, 'explicit-markdown')
    f.plugin(explicitMarkdown, 'reply-markdown')
    f.env.CLAUDE_CODE_PLUGIN_DIRS = explicitMarkdown
    expect(
      await f.launch({
        CLAUDE_CONFIG_DIR: inheritedProfile,
        CLAUDE_CODE_PLUGIN_DIRS: inheritedMedia
      })
    ).toEqual([explicitMarkdown, join(f.bundle, 'reply-media')])
    expect(f.env.CLAUDE_CONFIG_DIR).toBe(f.configDir)
  })

  it('honors an explicit empty plugin list instead of the inherited daemon list', async () => {
    const f = fixture()
    const inherited = join(f.root, 'inherited-markdown')
    f.plugin(inherited, 'reply-markdown')
    f.env.CLAUDE_CODE_PLUGIN_DIRS = ''
    expect(await f.launch({ CLAUDE_CODE_PLUGIN_DIRS: inherited })).toEqual([
      join(f.bundle, 'reply-markdown'),
      join(f.bundle, 'reply-media')
    ])
  })

  it('uses the supplied overlay baseline when disabling rich output', async () => {
    const f = fixture()
    const original = join(f.root, 'original-plugin')
    const overlay = [original, join(f.bundle, 'reply-media')].join(delimiter)
    f.env.CLAUDE_CODE_PLUGIN_DIRS = overlay
    f.env.ORCA_CLAUDE_RICH_OUTPUT = '0'
    expect(
      await f.launch({
        ORCA_CLAUDE_PLUGIN_DIRS: overlay,
        ORCA_CLAUDE_SOURCE_PLUGIN_DIRS: original
      })
    ).toEqual([original])
    expect(f.env.ORCA_CLAUDE_PLUGIN_DIRS).toBeUndefined()
  })

  it('ignores a configured plugin entry that is an ordinary file', async () => {
    const f = fixture()
    const note = join(f.root, 'notes.txt')
    writeFileSync(note, 'not a plugin directory')
    f.env.CLAUDE_CODE_PLUGIN_DIRS = note
    expect(await f.launch()).toEqual([
      note,
      join(f.bundle, 'reply-markdown'),
      join(f.bundle, 'reply-media')
    ])
  })

  it('ignores a skills root that is an ordinary file', async () => {
    const f = fixture()
    mkdirSync(f.configDir, { recursive: true })
    writeFileSync(join(f.configDir, 'skills'), 'not a skills directory')
    expect(await f.launch()).toEqual([
      join(f.bundle, 'reply-markdown'),
      join(f.bundle, 'reply-media')
    ])
  })

  it('reports the inspection failure cause while preserving an ordinary launch', async () => {
    const f = fixture()
    json(join(f.configDir, 'plugins', 'installed_plugins.json'), { version: 1, plugins: {} })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await f.launch()).toEqual([])
    expect(warning.mock.calls.flat().join(' ')).toContain(
      'Unrecognized Claude plugin install metadata'
    )
  })

  it.each([2, 3])(
    'accepts compatible version %s metadata with additional fields',
    async (version) => {
      const f = fixture()
      const installPath = join(f.root, 'marketplace', 'custom-media')
      f.plugin(installPath, 'reply-media')
      const installFile = join(f.configDir, 'plugins', 'installed_plugins.json')
      json(installFile, {
        version,
        generatedBy: 'newer-claude',
        plugins: {
          'pictures@user-market': [
            { scope: 'user', installPath, provenance: { revision: 'new-field' } }
          ]
        }
      })
      const settingsFile = join(f.configDir, 'settings.json')
      json(settingsFile, { enabledPlugins: { 'pictures@user-market': false } })
      const before = [readFileSync(installFile, 'utf8'), readFileSync(settingsFile, 'utf8')]
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(await f.launch()).toEqual([join(f.bundle, 'reply-markdown')])
      expect(f.env.ORCA_CLAUDE_PLUGIN_DIRS).toBe(join(f.bundle, 'reply-markdown'))
      expect([readFileSync(installFile, 'utf8'), readFileSync(settingsFile, 'utf8')]).toEqual(
        before
      )
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it.each([2, 3])(
    'preserves the original launch for an unknown version %s install shape',
    async (version) => {
      const f = fixture()
      const original = join(f.root, 'original-plugin')
      f.plugin(original, 'custom-plugin')
      f.env.CLAUDE_CODE_PLUGIN_DIRS = original
      const installFile = join(f.configDir, 'plugins', 'installed_plugins.json')
      json(installFile, {
        version,
        plugins: {
          'pictures@user-market': [
            { scope: 'workspace', installPath: join(f.root, 'future-scope') }
          ]
        }
      })
      const before = readFileSync(installFile, 'utf8')
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(await f.launch()).toEqual([original])
      expect(f.env.ORCA_CLAUDE_PLUGIN_DIRS).toBeUndefined()
      expect(f.env.ORCA_CLAUDE_RICH_OUTPUT).toBeUndefined()
      expect(readFileSync(installFile, 'utf8')).toBe(before)
      expect(warning.mock.calls.flat().join(' ')).toContain(
        'Unrecognized Claude plugin install metadata'
      )
    }
  )

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
