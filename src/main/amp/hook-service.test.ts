import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { AmpHookService, _internals } from './hook-service'

describe('AmpHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-amp-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('does not overwrite an existing user-authored Amp plugin file', () => {
    const pluginPath = _internals.getPluginPath()
    mkdirSync(dirname(pluginPath), { recursive: true })
    writeFileSync(pluginPath, 'export default function userPlugin() {}\n', 'utf-8')

    const status = new AmpHookService().install()

    expect(status).toMatchObject({
      agent: 'amp',
      state: 'partial',
      managedHooksPresent: false
    })
    expect(readFileSync(pluginPath, 'utf-8')).toBe('export default function userPlugin() {}\n')
  })

  it('removes only Orca-managed Amp plugin files', () => {
    const service = new AmpHookService()
    const installed = service.install()
    expect(existsSync(installed.configPath)).toBe(true)

    const removed = service.remove()

    expect(removed.state).toBe('not_installed')
    expect(existsSync(installed.configPath)).toBe(false)

    const pluginPath = _internals.getPluginPath()
    mkdirSync(dirname(pluginPath), { recursive: true })
    writeFileSync(pluginPath, 'export default function userPlugin() {}\n', 'utf-8')

    const skipped = service.remove()

    expect(skipped.state).toBe('partial')
    expect(existsSync(pluginPath)).toBe(true)
  })

  it('reports partial for stale managed plugin content missing required handlers', () => {
    const pluginPath = _internals.getPluginPath()
    mkdirSync(dirname(pluginPath), { recursive: true })
    writeFileSync(pluginPath, `// ${_internals.AMP_PLUGIN_MARKER}\n`, 'utf-8')

    const status = new AmpHookService().getStatus()

    expect(status).toMatchObject({
      agent: 'amp',
      state: 'partial',
      managedHooksPresent: true
    })
    expect(status.detail).toContain('missing required handlers')
  })

  it('reports partial when a stale managed plugin is missing the session reset handler', () => {
    const pluginPath = _internals.getPluginPath()
    mkdirSync(dirname(pluginPath), { recursive: true })
    writeFileSync(
      pluginPath,
      [
        `// ${_internals.AMP_PLUGIN_MARKER}`,
        "amp.on('agent.start', () => {})",
        "amp.on('tool.call', () => {})",
        "amp.on('tool.result', () => {})",
        "amp.on('agent.end', () => {})",
        '/hook/amp',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = new AmpHookService().getStatus()

    expect(status).toMatchObject({
      agent: 'amp',
      state: 'partial',
      managedHooksPresent: true
    })
    expect(status.detail).toContain('missing required handlers')
  })
})
