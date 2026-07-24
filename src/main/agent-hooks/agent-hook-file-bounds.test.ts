import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import { AmpHookService, _internals as ampInternals } from '../amp/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { getDevinConfigPath, getDevinManagedScriptPath } from '../devin/hook-settings'
import { HermesHookService, _internals as hermesInternals } from '../hermes/hook-service'
import { KimiHookService } from '../kimi/hook-service'
import {
  AGENT_HOOK_CONFIG_MAX_BYTES,
  AGENT_HOOK_CONFIG_MAX_STRUCTURAL_TOKENS,
  AGENT_HOOK_MANAGED_SCRIPT_MAX_BYTES,
  AGENT_HOOK_PLUGIN_MAX_BYTES
} from './agent-hook-file-limits'
import {
  readHooksJson,
  readHooksJsonRawForGenerationCheck,
  writeHooksJson,
  writeManagedScript
} from './installer-utils'

let root: string

function writeSparseFile(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, bytes)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-hook-bounds-'))
  homedirMock.mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  vi.stubEnv('KIMI_CODE_HOME', join(root, '.kimi-code'))
  vi.stubEnv('APPDATA', join(root, 'AppData', 'Roaming'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('agent hook file bounds', () => {
  it('fails closed when hooks JSON exceeds the comparison and generation limit', () => {
    const configPath = join(root, 'hooks.json')
    writeSparseFile(configPath, AGENT_HOOK_CONFIG_MAX_BYTES + 1)
    const originalSize = statSync(configPath).size

    expect(readHooksJson(configPath)).toBeNull()
    expect(() => readHooksJsonRawForGenerationCheck(configPath)).toThrow(NodeFileReadTooLargeError)
    expect(() => writeHooksJson(configPath, { hooks: {} })).toThrow(NodeFileReadTooLargeError)
    expect(statSync(configPath).size).toBe(originalSize)
  })

  it('rejects structurally amplified hooks JSON before parsing', () => {
    const configPath = join(root, 'hooks.json')
    writeFileSync(configPath, `[${'0,'.repeat(AGENT_HOOK_CONFIG_MAX_STRUCTURAL_TOKENS)}0]`, 'utf8')
    const parseSpy = vi.spyOn(JSON, 'parse')

    expect(readHooksJson(configPath)).toBeNull()
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('does not replace an oversized managed script during its equality check', () => {
    const scriptPath = join(root, '.orca', 'agent-hooks', 'status-hook.sh')
    writeSparseFile(scriptPath, AGENT_HOOK_MANAGED_SCRIPT_MAX_BYTES + 1)
    const originalSize = statSync(scriptPath).size

    expect(() => writeManagedScript(scriptPath, '#!/bin/sh\n')).toThrow(NodeFileReadTooLargeError)
    expect(statSync(scriptPath).size).toBe(originalSize)
  })

  it('does not replace an oversized Amp plugin', () => {
    const pluginPath = ampInternals.getPluginPath()
    writeSparseFile(pluginPath, AGENT_HOOK_PLUGIN_MAX_BYTES + 1)
    const originalSize = statSync(pluginPath).size

    const status = new AmpHookService().install()

    expect(status).toMatchObject({ state: 'error', managedHooksPresent: false })
    expect(status.detail).toContain('File too large')
    expect(statSync(pluginPath).size).toBe(originalSize)
  })

  it('does not create Hermes plugin files when config.yaml is oversized', () => {
    const configPath = join(process.env.HERMES_HOME!, 'config.yaml')
    writeSparseFile(configPath, AGENT_HOOK_CONFIG_MAX_BYTES + 1)
    const originalSize = statSync(configPath).size

    const status = new HermesHookService().install()

    expect(status.state).toBe('error')
    expect(status.detail).toContain('File too large')
    expect(statSync(configPath).size).toBe(originalSize)
    expect(
      existsSync(
        join(process.env.HERMES_HOME!, 'plugins', hermesInternals.HERMES_PLUGIN_NAME, 'plugin.yaml')
      )
    ).toBe(false)
  })

  it('does not replace an oversized Hermes plugin manifest', () => {
    const manifestPath = join(
      process.env.HERMES_HOME!,
      'plugins',
      hermesInternals.HERMES_PLUGIN_NAME,
      'plugin.yaml'
    )
    writeSparseFile(manifestPath, AGENT_HOOK_PLUGIN_MAX_BYTES + 1)
    const originalSize = statSync(manifestPath).size

    const status = new HermesHookService().install()

    expect(status.state).toBe('error')
    expect(status.detail).toContain('File too large')
    expect(statSync(manifestPath).size).toBe(originalSize)
    expect(existsSync(join(process.env.HERMES_HOME!, 'config.yaml'))).toBe(false)
  })

  it('does not create a Kimi script or replace an oversized config.toml', () => {
    const configPath = join(process.env.KIMI_CODE_HOME!, 'config.toml')
    const scriptPath = join(root, '.orca', 'agent-hooks', 'kimi-hook.sh')
    writeSparseFile(configPath, AGENT_HOOK_CONFIG_MAX_BYTES + 1)
    const originalSize = statSync(configPath).size

    const status = new KimiHookService().install()

    expect(status.state).toBe('error')
    expect(statSync(configPath).size).toBe(originalSize)
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('does not create a Devin script or replace an oversized config.json', () => {
    const configPath = getDevinConfigPath()
    writeSparseFile(configPath, AGENT_HOOK_CONFIG_MAX_BYTES + 1)
    const originalSize = statSync(configPath).size

    const status = new DevinHookService().install()

    expect(status.state).toBe('error')
    expect(statSync(configPath).size).toBe(originalSize)
    expect(existsSync(getDevinManagedScriptPath())).toBe(false)
  })
})
