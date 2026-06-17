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
import { resolvePiSourceAgentDir } from './plugin-overlay-env'

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

  it('uses the kind-specific Pi-compatible extension source when available', () => {
    manager.setSources({
      piExtensionSource: '// pi extension',
      ompExtensionSource: '// omp extension'
    })

    const piDir = manager.materializePi('tab-kind-pi:0', undefined, 'pi')
    const ompDir = manager.materializePi('tab-kind-omp:0', undefined, 'omp')

    expect(piDir).not.toBeNull()
    expect(ompDir).not.toBeNull()
    expect(readFileSync(join(piDir!, 'extensions', 'orca-agent-status.ts'), 'utf8')).toBe(
      '// pi extension'
    )
    expect(readFileSync(join(ompDir!, 'extensions', 'orca-agent-status.ts'), 'utf8')).toBe(
      '// omp extension'
    )
  })

  it('mirrors the remote default Pi agent dir before adding Orca status extension', () => {
    const piAgentDir = join(homeDir, '.pi', 'agent')
    mkdirSync(join(piAgentDir, 'skills', 'my-skill'), { recursive: true })
    mkdirSync(join(piAgentDir, 'extensions', 'user-ext'), { recursive: true })
    writeFileSync(join(piAgentDir, 'auth.json'), 'secret token')
    writeFileSync(join(piAgentDir, 'skills', 'my-skill', 'SKILL.md'), 'critical user skill')
    writeFileSync(join(piAgentDir, 'extensions', 'user-ext', 'ext.ts'), 'user extension')
    writeFileSync(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'amazon-bedrock',
        hideThinkingBlock: false,
        terminal: {
          showImages: false,
          clearOnShrink: false
        }
      })
    )

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
    expect(JSON.parse(readFileSync(join(dir!, 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: true,
      terminal: {
        showImages: false,
        clearOnShrink: true
      }
    })
    expect(JSON.parse(readFileSync(join(piAgentDir, 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: false,
      terminal: {
        showImages: false,
        clearOnShrink: false
      }
    })
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

  it('source-backs lazy OMP agent.db on the relay', () => {
    manager.setSources({ piExtensionSource: '// pi extension' })
    const sourceDir = join(homeDir, '.omp', 'agent')
    const firstDir = manager.materializePi('tab-relay-omp-sqlite:0', undefined, 'omp')

    expect(firstDir).not.toBeNull()
    const sourcePath = join(sourceDir, 'agent.db')
    const overlayPath = join(firstDir!, 'agent.db')
    const content = 'agent.db relay credentials'

    expect(existsSync(sourcePath)).toBe(true)
    expect(existsSync(overlayPath)).toBe(true)
    expect(existsSync(join(sourceDir, 'history.db'))).toBe(false)
    writeFileSync(overlayPath, content)

    expect(readFileSync(sourcePath, 'utf8')).toBe(content)

    const secondDir = manager.materializePi('tab-relay-omp-sqlite:0', undefined, 'omp')

    expect(secondDir).toBe(firstDir)
    expect(readFileSync(join(secondDir!, 'agent.db'), 'utf8')).toBe('agent.db relay credentials')
  })

  // Why: per-agent overlay source dir. The renderer picks Pi or OMP per
  // launch, and the relay must mirror the right `~/.<kind>/agent` source —
  // disk-presence guessing (always-Pi or first-exists) shadows the other
  // agent's user extensions when both dirs exist on the remote disk.
  describe('per-agent default source dir (no cross-agent fallback)', () => {
    function seedAgentDir(dotDir: '.pi' | '.omp', tag: string): string {
      const agentDir = join(homeDir, dotDir, 'agent')
      mkdirSync(join(agentDir, 'extensions', `${tag}-ext`), { recursive: true })
      writeFileSync(join(agentDir, 'extensions', `${tag}-ext`, 'ext.ts'), `${tag} extension`)
      writeFileSync(join(agentDir, 'auth.json'), `${tag} token`)
      return agentDir
    }

    it('launching pi with both ~/.pi/agent and ~/.omp/agent present mirrors ~/.pi/agent into pi-overlays', () => {
      seedAgentDir('.pi', 'pi')
      seedAgentDir('.omp', 'omp')

      manager.setSources({ piExtensionSource: '// pi extension' })
      const dir = manager.materializePi('tab-relay-pi-both:0', undefined, 'pi')

      expect(dir).not.toBeNull()
      // Pi overlays live under .orca-relay/pi-overlays, separate from OMP's tree.
      expect(dir!).toMatch(/[\\/]\.orca-relay[\\/]pi-overlays[\\/]/)
      expect(readFileSync(join(dir!, 'auth.json'), 'utf8')).toBe('pi token')
      const overlayExtensions = readdirSync(join(dir!, 'extensions')).sort()
      expect(overlayExtensions).toContain('pi-ext')
      expect(overlayExtensions).not.toContain('omp-ext')
    })

    it('launching omp with both ~/.pi/agent and ~/.omp/agent present mirrors ~/.omp/agent into omp-overlays', () => {
      seedAgentDir('.pi', 'pi')
      seedAgentDir('.omp', 'omp')

      manager.setSources({ piExtensionSource: '// pi extension' })
      const dir = manager.materializePi('tab-relay-omp-both:0', undefined, 'omp')

      expect(dir).not.toBeNull()
      // CRITICAL: OMP overlays live in a distinct subtree (.orca-relay/omp-overlays)
      // so the remote box never mixes Pi and OMP overlay state for the same paneKey.
      expect(dir!).toMatch(/[\\/]\.orca-relay[\\/]omp-overlays[\\/]/)
      expect(dir!).not.toMatch(/[\\/]pi-overlays[\\/]/)
      // Even though ~/.pi/agent exists, the OMP launch MUST mirror OMP's
      // source dir. Cross-agent fallback would silently shadow the user's
      // OMP extensions on the remote.
      expect(readFileSync(join(dir!, 'auth.json'), 'utf8')).toBe('omp token')
      const overlayExtensions = readdirSync(join(dir!, 'extensions')).sort()
      expect(overlayExtensions).toContain('omp-ext')
      expect(overlayExtensions).not.toContain('pi-ext')
    })

    it('launching omp when only ~/.pi/agent exists does NOT mirror Pi state', () => {
      // Why: missing OMP source dir on the remote must materialize the
      // overlay from empty — Orca's status extension only, no Pi state
      // cross-pollinated in.
      seedAgentDir('.pi', 'pi')
      expect(existsSync(join(homeDir, '.omp'))).toBe(false)

      manager.setSources({ piExtensionSource: '// pi extension' })
      const dir = manager.materializePi('tab-relay-omp-empty:0', undefined, 'omp')

      expect(dir).not.toBeNull()
      expect(dir!).toMatch(/[\\/]\.orca-relay[\\/]omp-overlays[\\/]/)
      // Pi-only home must NOT leak into the OMP overlay.
      expect(existsSync(join(dir!, 'auth.json'))).toBe(false)
      const overlayExtensions = readdirSync(join(dir!, 'extensions')).sort()
      expect(overlayExtensions).toEqual(['orca-agent-status.ts'])
      expect(JSON.parse(readFileSync(join(dir!, 'settings.json'), 'utf8'))).toEqual({
        hideThinkingBlock: true,
        terminal: { clearOnShrink: true }
      })
    })
  })

  it('does not override a missing preexisting Pi agent dir', () => {
    manager.setSources({ piExtensionSource: '// pi extension' })

    expect(manager.materializePi('tab-missing-pi:0', join(homeDir, 'missing-pi'))).toBeNull()
  })

  it('clearOverlay removes opencode + every Pi-kind overlay root for an id', () => {
    manager.setSources({
      opencodePluginSource: 'opencode',
      piExtensionSource: 'pi',
      ompExtensionSource: 'omp'
    })
    const opencodeDir = manager.materializeOpenCode('tab-3:0')!
    const piDir = manager.materializePi('tab-3:0', undefined, 'pi')!
    const ompDir = manager.materializePi('tab-3:0', undefined, 'omp')!
    // Sanity: each kind got its own subtree, not a shared one.
    expect(piDir).not.toBe(ompDir)
    expect(existsSync(opencodeDir)).toBe(true)
    expect(existsSync(piDir)).toBe(true)
    expect(existsSync(ompDir)).toBe(true)

    manager.clearOverlay('tab-3:0')

    expect(existsSync(opencodeDir)).toBe(false)
    expect(existsSync(piDir)).toBe(false)
    expect(existsSync(ompDir)).toBe(false)
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

describe('resolvePiSourceAgentDir', () => {
  it('uses only the selected kind source shadow when resolving inherited overlays', () => {
    const env = {
      HOME: mkdtempSync(join(tmpdir(), 'plugin-overlay-env-')),
      PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
      ORCA_PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
      ORCA_PI_SOURCE_AGENT_DIR: '/user/.pi/agent'
    }
    try {
      expect(resolvePiSourceAgentDir(env, undefined, 'pi')).toBe('/user/.pi/agent')
      expect(resolvePiSourceAgentDir(env, undefined, 'omp')).toBeUndefined()
    } finally {
      rmSync(env.HOME, { recursive: true, force: true })
    }
  })

  it('keeps explicit PI_CODING_AGENT_DIR values when they are not Orca overlays', () => {
    const env = {
      HOME: mkdtempSync(join(tmpdir(), 'plugin-overlay-env-')),
      PI_CODING_AGENT_DIR: '/user/custom-omp-agent',
      ORCA_PI_SOURCE_AGENT_DIR: '/user/.pi/agent'
    }
    try {
      expect(resolvePiSourceAgentDir(env, undefined, 'omp')).toBe('/user/custom-omp-agent')
    } finally {
      rmSync(env.HOME, { recursive: true, force: true })
    }
  })
})
