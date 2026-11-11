import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: homedirMock }
})

import { JcodeHookService } from './hook-service'
import {
  getJcodeConfigPath,
  getJcodeManagedCommand,
  getJcodeManagedScriptPath
} from './hook-settings'
import { tomlQuoteString } from './hook-config'

describe('JcodeHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-home-'))
    homedirMock.mockReturnValue(homeDir)
    // Isolate JCODE_HOME as well as homedir so installs cannot escape the temporary home.
    vi.stubEnv('JCODE_HOME', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('reports a missing managed script and repairs it without changing config', () => {
    const service = new JcodeHookService()
    service.install()
    const config = readFileSync(getJcodeConfigPath(), 'utf8')
    rmSync(getJcodeManagedScriptPath())

    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      managedHooksPresent: true,
      detail: 'Managed hook script missing'
    })
    expect(readFileSync(getJcodeConfigPath(), 'utf8')).toBe(config)
    expect(service.install().state).toBe('installed')
    expect(readFileSync(getJcodeManagedScriptPath(), 'utf8')).toContain('/hook/jcode')
    expect(readFileSync(getJcodeConfigPath(), 'utf8')).toBe(config)
  })

  it.each([
    '/Users/previous/.orca/agent-hooks/jcode-hook.sh',
    'C:\\Users\\previous\\.orca\\agent-hooks\\jcode-hook.cmd'
  ])('recognizes a stale managed command %s without a local script', (stalePath) => {
    const service = new JcodeHookService()
    const configPath = getJcodeConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `[hooks]\nturn_end = ${tomlQuoteString(getJcodeManagedCommand(stalePath))}\n`,
      'utf8'
    )

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('Managed hook command outdated for events: turn_end')
    expect(status.detail).toContain('Managed hook script missing')
    expect(status.detail).not.toContain('User-owned')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf8')).not.toContain('previous')
  })

  it('preserves unrelated config tables when installing hooks', () => {
    const configPath = getJcodeConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[display]\nemoji = false\n', 'utf8')
    new JcodeHookService().install()
    const config = readFileSync(configPath, 'utf8')
    expect(config).toContain('[display]')
    expect(config).toContain('emoji = false')
  })

  it('keeps user-owned hook commands and reports partial', () => {
    const configPath = getJcodeConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[hooks]\nturn_end = "~/bin/my-turn-notify"\n', 'utf8')
    const status = new JcodeHookService().install()
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('turn_end')
    expect(readFileSync(configPath, 'utf8')).toContain('turn_end = "~/bin/my-turn-notify"')
  })

  it('appends to user hook arrays and removes only its own element', () => {
    const configPath = getJcodeConfigPath()
    const source = `[hooks]\npre_tool = [\n    "~/gates/pre-tool.sh", # policy\n    "~/gates/memory-gate.sh",\n]\npre_tool_timeout_ms = 5000\n`
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, source, 'utf8')
    const service = new JcodeHookService()
    expect(service.getStatus().state).toBe('not_installed')

    expect(service.install().state).toBe('installed')
    const installed = readFileSync(configPath, 'utf8')
    expect(parseToml(installed).hooks).toMatchObject({
      pre_tool: [
        '~/gates/pre-tool.sh',
        '~/gates/memory-gate.sh',
        getJcodeManagedCommand(getJcodeManagedScriptPath())
      ],
      pre_tool_timeout_ms: 5000
    })
    expect(installed).toContain('"~/gates/pre-tool.sh", # policy')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf8')).toBe(installed)

    expect(service.remove().state).toBe('not_installed')
    expect(parseToml(readFileSync(configPath, 'utf8'))).toEqual(parseToml(source))
    expect(readFileSync(configPath, 'utf8')).toContain(
      'pre_tool = [\n    "~/gates/pre-tool.sh", # policy\n    "~/gates/memory-gate.sh",\n]\n'
    )
  })
})
