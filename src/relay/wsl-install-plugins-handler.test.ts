// POSIX-only: the guest relay runs inside the Linux distro and materializes
// overlays under a real $HOME. On a Windows dev host tmpdir() yields C:\ paths
// the overlay logic is not meant to serve; live coverage comes from the rig.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginOverlayManager } from './plugin-overlay'
import { createInstallPluginsHandler } from './wsl-install-plugins-handler'
import { PLUGIN_SOURCE_MAX_BYTES } from './plugin-source-limit'

describe.skipIf(process.platform === 'win32')('createInstallPluginsHandler (guest side)', () => {
  function freshHome(): string {
    return mkdtempSync(join(tmpdir(), 'wsl-guest-home-'))
  }

  function withHome(run: (home: string) => void): void {
    const home = freshHome()
    try {
      run(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('writes orca-opencode-status.js into the overlay and returns that dir', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const source = '// orca opencode status plugin\nexport const Plugin = () => ({})\n'
      const res = install({ opencodePluginSource: source })

      expect(res.installed.opencode).toBe(true)
      const dir = res.overlayDirs.opencode
      expect(typeof dir).toBe('string')
      const pluginPath = join(dir as string, 'plugins', 'orca-opencode-status.js')
      expect(existsSync(pluginPath)).toBe(true)
      expect(readFileSync(pluginPath, 'utf8')).toBe(source)
    })
  })

  it('reuses the overlay on repeat installs instead of rebuilding it', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const source = '// v1\n'
      const dir = install({ opencodePluginSource: source }).overlayDirs.opencode as string

      // Why: a wipe-and-rebuild would delete this alongside the rest of the tree,
      // pulling the config root out from under an agent already running against it.
      const canary = join(dir, 'opencode.json')
      writeFileSync(canary, '{"model":"user-set"}')

      // The host re-ships on every reinstall (60s one-shot, later pane spawns).
      expect(install({ opencodePluginSource: source }).overlayDirs.opencode).toBe(dir)
      expect(install({}).overlayDirs.opencode).toBe(dir)
      expect(existsSync(canary)).toBe(true)
    })
  })

  it('rebuilds if the resolved source dir ever changes (defensive)', () => {
    withHome((home) => {
      // The relay's env is fixed for its lifetime, so nothing in production reaches
      // this branch today; it exists so a plugin-only overlay can't outlive a source
      // dir becoming resolvable. Simulated by mutating the env the factory captured.
      const userConfig = join(home, 'my-opencode')
      const env = { HOME: home, ORCA_WSL_HOOK_INSTANCE: 'inst1' } as NodeJS.ProcessEnv
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), env)
      const source = '// v1\n'
      install({ opencodePluginSource: source })

      mkdirSync(userConfig, { recursive: true })
      writeFileSync(join(userConfig, 'opencode.json'), '{"model":"late"}')
      env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = userConfig

      const dir = install({ opencodePluginSource: source }).overlayDirs.opencode as string
      expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{"model":"late"}')
    })
  })

  it('rebuilds when the cached overlay lost its plugin file', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const source = '// v1\n'
      const dir = install({ opencodePluginSource: source }).overlayDirs.opencode as string
      // Why: a rebuild that failed after the wipe leaves the dir but not the plugin;
      // an existsSync on the dir alone would call that a cache hit forever.
      rmSync(join(dir, 'plugins', 'orca-opencode-status.js'))

      expect(install({ opencodePluginSource: source }).overlayDirs.opencode).toBe(dir)
      expect(existsSync(join(dir, 'plugins', 'orca-opencode-status.js'))).toBe(true)
    })
  })

  it('re-materializes when the shipped source changes', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      install({ opencodePluginSource: '// v1\n' })
      // Why: a mid-session Orca upgrade ships new plugin source; future spawns must see it.
      const dir = install({ opencodePluginSource: '// v2\n' }).overlayDirs.opencode as string
      expect(readFileSync(join(dir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe('// v2\n')
    })
  })

  it('rebuilds when the cached overlay disappeared from the guest', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const source = '// v1\n'
      const dir = install({ opencodePluginSource: source }).overlayDirs.opencode as string
      rmSync(dir, { recursive: true, force: true })

      expect(install({ opencodePluginSource: source }).overlayDirs.opencode).toBe(dir)
      expect(existsSync(join(dir, 'plugins', 'orca-opencode-status.js'))).toBe(true)
    })
  })

  it('mirrors an explicitly-set config root so overriding the var does not drop it', () => {
    withHome((home) => {
      // Why: setting OPENCODE_CONFIG_DIR to the overlay removes the user's own value
      // from OpenCode's config-dir list, so that one must be mirrored in.
      const userConfig = join(home, 'my-opencode')
      mkdirSync(userConfig, { recursive: true })
      writeFileSync(join(userConfig, 'opencode.json'), '{"model":"user-set"}')

      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: userConfig,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const dir = install({ opencodePluginSource: '// v1\n' }).overlayDirs.opencode as string

      expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{"model":"user-set"}')
      expect(existsSync(join(dir, 'plugins', 'orca-opencode-status.js'))).toBe(true)
    })
  })

  it('does not mirror the XDG default config root', () => {
    withHome((home) => {
      // Why: OpenCode APPENDS OPENCODE_CONFIG_DIR to its config-dir list rather than
      // replacing it, so ~/.config/opencode is read anyway — mirroring it here would
      // load the user's config and plugins twice.
      const defaultConfig = join(home, '.config', 'opencode')
      mkdirSync(defaultConfig, { recursive: true })
      writeFileSync(join(defaultConfig, 'opencode.json'), '{"model":"default"}')

      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)
      const dir = install({ opencodePluginSource: '// v1\n' }).overlayDirs.opencode as string

      expect(existsSync(join(dir, 'opencode.json'))).toBe(false)
      expect(existsSync(join(dir, 'plugins', 'orca-opencode-status.js'))).toBe(true)
    })
  })

  it('rejects a source that exceeds the byte cap before writing anything', () => {
    withHome((home) => {
      const overlay = new PluginOverlayManager({ homeDir: home })
      const install = createInstallPluginsHandler(overlay, {
        HOME: home
      } as NodeJS.ProcessEnv)
      const tooBig = 'a'.repeat(PLUGIN_SOURCE_MAX_BYTES + 1)
      expect(() => install({ opencodePluginSource: tooBig })).toThrow(/byte cap/)
      expect(overlay.hasOpenCodeSource()).toBe(false)
    })
  })

  it('returns no overlay dir when no opencode source is provided', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home
      } as NodeJS.ProcessEnv)
      const res = install({})
      expect(res.installed.opencode).toBe(false)
      expect(res.overlayDirs.opencode).toBeUndefined()
    })
  })
})
