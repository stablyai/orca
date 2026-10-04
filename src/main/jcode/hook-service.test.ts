import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  // oxlint-disable-next-line typescript/consistent-type-imports -- vi.importActual needs the inline import() to type the real module
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: homedirMock }
})

import { JcodeHookService } from './hook-service'
import {
  getJcodeConfigPath,
  getJcodeManagedCommand,
  getJcodeManagedScriptFileName,
  getJcodeManagedScriptPath,
  JCODE_HOOK_EVENTS
} from './hook-settings'
import { tomlQuoteString } from './hook-config'

describe('JcodeHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-home-'))
    homedirMock.mockReturnValue(homeDir)
    // Why: getJcodeConfigPath prefers JCODE_HOME; an ambient value would write
    // outside the temp home and leak the written config past afterEach.
    vi.stubEnv('JCODE_HOME', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('reports not_installed before any install', () => {
    const status = new JcodeHookService().getStatus()
    expect(status).toMatchObject({
      agent: 'jcode',
      state: 'not_installed',
      configPath: getJcodeConfigPath()
    })
  })

  it('installs managed hooks into jcode config.toml and posts to /hook/jcode', () => {
    const status = new JcodeHookService().install()
    expect(status.state).toBe('installed')
    expect(status.agent).toBe('jcode')
    expect(status.configPath).toBe(getJcodeConfigPath())
    expect(status.managedHooksPresent).toBe(true)

    const config = readFileSync(getJcodeConfigPath(), 'utf8')
    for (const event of JCODE_HOOK_EVENTS) {
      // Why both wrappers: the value is shell-quoted for jcode's hook tokenizer and
      // then TOML-quoted for the file, so neither the raw path nor the shell-quoted
      // string appears on its own.
      expect(config).toContain(
        `${event} = ${tomlQuoteString(getJcodeManagedCommand(getJcodeManagedScriptPath()))}`
      )
    }
    const script = readFileSync(getJcodeManagedScriptPath(), 'utf8')
    expect(script).toContain('/hook/jcode')
    expect(script).toContain('payload@-')
    // Why: the payload is jcode's own JCODE_HOOK_PAYLOAD, forwarded verbatim.
    expect(script).toContain('$JCODE_HOOK_PAYLOAD')
    expect(script).toContain('payload="$JCODE_HOOK_PAYLOAD"')
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

  it('reports missing scripts alongside incomplete event coverage and user hooks', () => {
    const service = new JcodeHookService()
    service.install()
    writeFileSync(
      getJcodeConfigPath(),
      `[hooks]\nsession_start = ${tomlQuoteString(getJcodeManagedCommand(getJcodeManagedScriptPath()))}\nturn_end = "~/bin/my-turn-notify"\n`,
      'utf8'
    )
    rmSync(getJcodeManagedScriptPath())

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('Managed hook script missing')
    expect(status.detail).toContain(
      'Managed hook missing for events: turn_start, pre_tool, post_tool, session_end'
    )
    expect(status.detail).toContain('User-owned hooks kept for events: turn_end')
    expect(service.install().state).toBe('partial')
    expect(service.getStatus().detail).not.toContain('script missing')
    expect(readFileSync(getJcodeConfigPath(), 'utf8')).toContain(
      'turn_end = "~/bin/my-turn-notify"'
    )
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

  it('does not report complete stale event coverage as installed when the current script exists', () => {
    const service = new JcodeHookService()
    service.install()
    const staleCommand = getJcodeManagedCommand('/Users/previous/.orca/agent-hooks/jcode-hook.sh')
    writeFileSync(
      getJcodeConfigPath(),
      `[hooks]\n${JCODE_HOOK_EVENTS.map((event) => `${event} = ${tomlQuoteString(staleCommand)}`).join('\n')}\n`,
      'utf8'
    )

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe(
      `Managed hook command outdated for events: ${JCODE_HOOK_EVENTS.join(', ')}`
    )
    expect(service.install().state).toBe('installed')
  })

  it('reports legacy unquoted commands as outdated even when the script exists', () => {
    const service = new JcodeHookService()
    service.install()
    writeFileSync(
      getJcodeConfigPath(),
      `[hooks]\n${JCODE_HOOK_EVENTS.map((event) => `${event} = ${tomlQuoteString(getJcodeManagedScriptPath())}`).join('\n')}\n`,
      'utf8'
    )

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('Managed hook command outdated for events:')
    expect(status.detail).not.toContain('script missing')
    expect(status.detail).not.toContain('User-owned')
    expect(service.install().state).toBe('installed')
  })

  it('does not mistake a user command mentioning the managed script in a comment for Orca ownership', () => {
    const configPath = getJcodeConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `[hooks]\nturn_end = "~/bin/my-turn-notify" # replaces agent-hooks/${getJcodeManagedScriptFileName()}\n`,
      'utf8'
    )

    const status = new JcodeHookService().getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(false)
    expect(status.detail).toContain('User-owned hooks kept for events: turn_end')
    expect(status.detail).not.toContain('command outdated')
    expect(status.detail).not.toContain('script missing')
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

  it('reports error when the [hooks] table holds a non-scalar value', () => {
    const configPath = getJcodeConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[hooks]\nturn_end = """\nmultiline\n"""\n', 'utf8')
    const status = new JcodeHookService().install()
    expect(status.state).toBe('error')
    expect(status.detail).toContain('config.toml')
  })

  it('remove clears only the managed entries', () => {
    new JcodeHookService().install()
    const before = readFileSync(getJcodeConfigPath(), 'utf8')
    expect(before).toContain('turn_end')
    const status = new JcodeHookService().remove()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toBeNull()
    expect(existsSync(getJcodeManagedScriptPath())).toBe(true)
    const after = readFileSync(getJcodeConfigPath(), 'utf8')
    expect(after).not.toContain(getJcodeManagedScriptPath())
  })
})
