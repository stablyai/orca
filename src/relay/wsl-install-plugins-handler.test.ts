// POSIX-only: the guest relay runs inside the Linux distro and materializes
// overlays under a real $HOME. On a Windows dev host tmpdir() yields C:\ paths
// the overlay logic is not meant to serve; live coverage comes from the rig.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginOverlayManager } from './plugin-overlay'
import { handleInstallPlugins } from './wsl-install-plugins-handler'
import { PLUGIN_SOURCE_MAX_BYTES } from './plugin-source-limit'

describe.skipIf(process.platform === 'win32')('handleInstallPlugins (guest side)', () => {
  function freshHome(): string {
    return mkdtempSync(join(tmpdir(), 'wsl-guest-home-'))
  }

  it('writes orca-opencode-status.js into the overlay and returns that dir', () => {
    const home = freshHome()
    try {
      const overlay = new PluginOverlayManager({ homeDir: home })
      const source = '// orca opencode status plugin\nexport const Plugin = () => ({})\n'
      const res = handleInstallPlugins(overlay, { opencodePluginSource: source }, {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      } as NodeJS.ProcessEnv)

      expect(res.installed.opencode).toBe(true)
      const dir = res.overlayDirs.opencode
      expect(typeof dir).toBe('string')
      const pluginPath = join(dir as string, 'plugins', 'orca-opencode-status.js')
      expect(existsSync(pluginPath)).toBe(true)
      expect(readFileSync(pluginPath, 'utf8')).toBe(source)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a source that exceeds the byte cap before writing anything', () => {
    const home = freshHome()
    try {
      const overlay = new PluginOverlayManager({ homeDir: home })
      const tooBig = 'a'.repeat(PLUGIN_SOURCE_MAX_BYTES + 1)
      expect(() =>
        handleInstallPlugins(overlay, { opencodePluginSource: tooBig }, {
          HOME: home
        } as NodeJS.ProcessEnv)
      ).toThrow(/byte cap/)
      expect(overlay.hasOpenCodeSource()).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns no overlay dir when no opencode source is provided', () => {
    const home = freshHome()
    try {
      const overlay = new PluginOverlayManager({ homeDir: home })
      const res = handleInstallPlugins(overlay, {}, { HOME: home } as NodeJS.ProcessEnv)
      expect(res.installed.opencode).toBe(false)
      expect(res.overlayDirs.opencode).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
