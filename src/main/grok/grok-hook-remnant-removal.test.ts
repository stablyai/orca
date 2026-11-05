import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { GrokHookService } from './hook-service'
// Hookless Orca-owned remnants must not masquerade as deliberate user opt-outs and block reinstall.
const SCHEMA = 'https://grok.example/hooks.schema.json'

describe('Grok hook removal leaves no remnant that blocks reinstall', () => {
  let homeDir: string
  let configPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-remnant-'))
    homedirMock.mockReturnValue(homeDir)
    configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function installThenAddSchema(service: GrokHookService): void {
    expect(service.install().state).toBe('installed')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    config.$schema = SCHEMA
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }

  it('removes it on the sync path', () => {
    const service = new GrokHookService()
    installThenAddSchema(service)

    expect(service.remove().state).toBe('not_installed')

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })

  it('removes it on the quit path', async () => {
    const service = new GrokHookService()
    installThenAddSchema(service)

    await service.removeAsync()

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })
})
