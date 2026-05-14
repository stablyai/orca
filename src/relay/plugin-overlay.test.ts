import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { PluginOverlayManager } from './plugin-overlay'

describe('PluginOverlayManager', () => {
  let homeDir: string
  let manager: PluginOverlayManager

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'plugin-overlay-'))
    manager = new PluginOverlayManager({ homeDir })
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('reports no source until install runs', () => {
    expect(manager.hasOpenCodeSource()).toBe(false)
    expect(manager.hasPiSource()).toBe(false)
    expect(manager.materializeOpenCode('tab-1:0')).toBeNull()
    expect(manager.materializePi('tab-1:0')).toBeNull()
  })

  it('materializes OpenCode plugin into <overlay>/plugins/<file>', () => {
    manager.setSources({ opencodePluginSource: 'export const X = 1' })
    const dir = manager.materializeOpenCode('tab-1:0')
    expect(dir).not.toBeNull()
    const expected = join(dir!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, 'utf8')).toBe('export const X = 1')
  })

  it('mirrors a preexisting remote OpenCode config dir before adding Orca plugin', () => {
    const userConfigDir = join(homeDir, 'company-opencode')
    mkdirSync(join(userConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(userConfigDir, 'opencode.json'), '{"provider":"custom"}')
    writeFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'user plugin')
    writeFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), 'user same-name')

    manager.setSources({ opencodePluginSource: 'orca plugin' })
    const dir = manager.materializeOpenCode('tab-opencode:0', userConfigDir)

    expect(dir).not.toBeNull()
    expect(readFileSync(join(dir!, 'opencode.json'), 'utf8')).toBe('{"provider":"custom"}')
    expect(readFileSync(join(dir!, 'plugins', 'user-plugin.js'), 'utf8')).toBe('user plugin')
    expect(readFileSync(join(dir!, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      'orca plugin'
    )
    expect(readFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      'user same-name'
    )
  })

  it('does not override a missing preexisting OpenCode config dir', () => {
    manager.setSources({ opencodePluginSource: 'orca plugin' })

    expect(manager.materializeOpenCode('tab-missing:0', join(homeDir, 'missing'))).toBeNull()
  })

  it('materializes Pi extension into <overlay>/extensions/<file>', () => {
    manager.setSources({ piExtensionSource: '// pi extension' })
    const dir = manager.materializePi('tab-2:0')
    expect(dir).not.toBeNull()
    const file = join(dir!, 'extensions', 'orca-agent-status.ts')
    expect(existsSync(file)).toBe(true)
  })

  it('mirrors the remote default Pi agent dir before adding Orca status extension', () => {
    const piAgentDir = join(homeDir, '.pi', 'agent')
    mkdirSync(join(piAgentDir, 'skills', 'my-skill'), { recursive: true })
    mkdirSync(join(piAgentDir, 'extensions', 'user-ext'), { recursive: true })
    writeFileSync(join(piAgentDir, 'auth.json'), 'secret token')
    writeFileSync(join(piAgentDir, 'skills', 'my-skill', 'SKILL.md'), 'critical user skill')
    writeFileSync(join(piAgentDir, 'extensions', 'user-ext', 'ext.ts'), 'user extension')

    manager.setSources({ piExtensionSource: '// pi extension' })
    const dir = manager.materializePi('tab-pi:0')

    expect(dir).not.toBeNull()
    expect(readFileSync(join(dir!, 'auth.json'), 'utf8')).toBe('secret token')
    expect(readFileSync(join(dir!, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe(
      'critical user skill'
    )
    expect(readFileSync(join(dir!, 'extensions', 'user-ext', 'ext.ts'), 'utf8')).toBe(
      'user extension'
    )
    expect(readdirSync(join(dir!, 'extensions')).sort()).toEqual([
      'orca-agent-status.ts',
      'user-ext'
    ])
  })

  it('mirrors a preexisting remote Pi agent dir instead of the default', () => {
    const defaultAgentDir = join(homeDir, '.pi', 'agent')
    const customAgentDir = join(homeDir, 'custom-pi-agent')
    mkdirSync(defaultAgentDir, { recursive: true })
    mkdirSync(join(customAgentDir, 'extensions'), { recursive: true })
    writeFileSync(join(defaultAgentDir, 'auth.json'), 'default token')
    writeFileSync(join(customAgentDir, 'auth.json'), 'custom token')
    writeFileSync(join(customAgentDir, 'extensions', 'custom.ts'), 'custom extension')

    manager.setSources({ piExtensionSource: '// pi extension' })
    const dir = manager.materializePi('tab-custom-pi:0', customAgentDir)

    expect(dir).not.toBeNull()
    expect(readFileSync(join(dir!, 'auth.json'), 'utf8')).toBe('custom token')
    expect(readFileSync(join(dir!, 'extensions', 'custom.ts'), 'utf8')).toBe('custom extension')
    expect(readFileSync(join(dir!, 'extensions', 'orca-agent-status.ts'), 'utf8')).toBe(
      '// pi extension'
    )
  })

  it('does not override a missing preexisting Pi agent dir', () => {
    manager.setSources({ piExtensionSource: '// pi extension' })

    expect(manager.materializePi('tab-missing-pi:0', join(homeDir, 'missing-pi'))).toBeNull()
  })

  it('clearOverlay removes both overlay roots for an id', () => {
    manager.setSources({
      opencodePluginSource: 'opencode',
      piExtensionSource: 'pi'
    })
    const opencodeDir = manager.materializeOpenCode('tab-3:0')!
    const piRoot = manager.materializePi('tab-3:0')!
    expect(existsSync(opencodeDir)).toBe(true)
    expect(existsSync(piRoot)).toBe(true)

    manager.clearOverlay('tab-3:0')

    expect(existsSync(opencodeDir)).toBe(false)
    expect(existsSync(piRoot)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'clearOverlay removes OpenCode overlay symlinks without deleting their targets',
    () => {
      const userConfigDir = join(homeDir, 'company-opencode')
      const linkedTarget = join(homeDir, 'linked-plugin-target')
      mkdirSync(join(userConfigDir, 'plugins'), { recursive: true })
      mkdirSync(linkedTarget, { recursive: true })
      writeFileSync(join(linkedTarget, 'keep.js'), 'do not delete')
      symlinkSync(linkedTarget, join(userConfigDir, 'plugins', 'linked-plugin'), 'dir')

      manager.setSources({ opencodePluginSource: 'orca plugin' })
      const dir = manager.materializeOpenCode('tab-opencode-symlink:0', userConfigDir)!
      expect(existsSync(join(dir, 'plugins', 'linked-plugin'))).toBe(true)

      manager.clearOverlay('tab-opencode-symlink:0')

      expect(existsSync(dir)).toBe(false)
      expect(readFileSync(join(linkedTarget, 'keep.js'), 'utf8')).toBe('do not delete')
    }
  )

  it('produces stable overlay dirs for a given id (idempotent re-materialization)', () => {
    manager.setSources({ opencodePluginSource: 'first' })
    const dirA = manager.materializeOpenCode('tab-stable:0')!
    manager.setSources({ opencodePluginSource: 'second' })
    const dirB = manager.materializeOpenCode('tab-stable:0')!
    expect(dirA).toBe(dirB)
    expect(readFileSync(join(dirA, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe('second')
  })

  it('hashes unsafe pane ids into portable overlay directory names', () => {
    manager.setSources({ opencodePluginSource: 'plugin' })
    const dir = manager.materializeOpenCode('tab/with\\unsafe:chars\n0')

    expect(dir).not.toBeNull()
    expect(basename(dir!)).toMatch(/^[a-f0-9]{32}$/)
    expect(dir).not.toContain('tab/with')
    expect(existsSync(join(dir!, 'plugins', 'orca-opencode-status.js'))).toBe(true)
  })
})
