import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

  it('materializes Pi extension into <overlay>/.pi/agent/<file>', () => {
    manager.setSources({ piExtensionSource: '// pi extension' })
    const dir = manager.materializePi('tab-2:0')
    expect(dir).not.toBeNull()
    // Why: returns the *root* overlay path so the caller assigns it to
    // PI_CODING_AGENT_DIR (which Pi treats as the dir containing .pi).
    const file = join(dir!, '.pi', 'agent', 'orca-agent-status.ts')
    expect(existsSync(file)).toBe(true)
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

  it('produces stable overlay dirs for a given id (idempotent re-materialization)', () => {
    manager.setSources({ opencodePluginSource: 'first' })
    const dirA = manager.materializeOpenCode('tab-stable:0')!
    manager.setSources({ opencodePluginSource: 'second' })
    const dirB = manager.materializeOpenCode('tab-stable:0')!
    expect(dirA).toBe(dirB)
    expect(readFileSync(join(dirA, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe('second')
  })
})
