import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'

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
  getJcodeManagedScriptFileName,
  getJcodeManagedScriptPath,
  getJcodeRemoteManagedCommand,
  JCODE_HOOK_EVENTS
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
      // Commands are shell-quoted for jcode, then TOML-quoted for config storage.
      expect(config).toContain(
        `${event} = ${tomlQuoteString(getJcodeManagedCommand(getJcodeManagedScriptPath()))}`
      )
    }
    const script = readFileSync(getJcodeManagedScriptPath(), 'utf8')
    expect(script).toContain('/hook/jcode')
    expect(script).toContain('payload@-')
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
    // Write the stale entry in the form its own platform installs.
    const platform = vi.spyOn(process, 'platform', 'get')
    platform.mockReturnValue(stalePath.endsWith('.cmd') ? 'win32' : 'linux')
    const staleCommand = getJcodeManagedCommand(stalePath)
    platform.mockRestore()
    writeFileSync(configPath, `[hooks]\nturn_end = ${tomlQuoteString(staleCommand)}\n`, 'utf8')

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('Managed hook command outdated for events: turn_end')
    expect(status.detail).toContain('Managed hook script missing')
    expect(status.detail).not.toContain('User-owned')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf8')).not.toContain('previous')
  })

  it('does not report stale managed commands as installed beside the current one', () => {
    const service = new JcodeHookService()
    service.install()
    const staleCommand = getJcodeManagedCommand('/Users/previous/.orca/agent-hooks/jcode-hook.sh')
    writeFileSync(
      getJcodeConfigPath(),
      `[hooks]\n${JCODE_HOOK_EVENTS.map((event) => `${event} = [${tomlQuoteString(staleCommand)}, ${tomlQuoteString(getJcodeManagedCommand(getJcodeManagedScriptPath()))}]`).join('\n')}\n`,
      'utf8'
    )

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe(
      `Managed hook command outdated for events: ${JCODE_HOOK_EVENTS.join(', ')}`
    )
    expect(service.install().state).toBe('installed')
    expect(readFileSync(getJcodeConfigPath(), 'utf8')).not.toContain('previous')
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

  it('rewrites a bare-path install from before the missing-script guard, once per event', () => {
    const configPath = getJcodeConfigPath()
    // The pre-guard form: the script path alone, quoted for jcode's tokenizer.
    const legacy = tomlQuoteString(`'${getJcodeManagedScriptPath()}'`)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `[hooks]\n${JCODE_HOOK_EVENTS.map((event) =>
        event === 'pre_tool'
          ? `${event} = ["~/gates/pre-tool.sh", ${legacy}]`
          : `${event} = ${legacy}`
      ).join('\n')}\n`,
      'utf8'
    )
    const service = new JcodeHookService()
    expect(service.getStatus().detail).toContain('Managed hook command outdated')

    expect(service.install().state).toBe('installed')
    const guarded = getJcodeManagedCommand(getJcodeManagedScriptPath())
    expect(guarded.startsWith('/bin/sh -c ')).toBe(process.platform !== 'win32')
    expect(parseToml(readFileSync(configPath, 'utf8')).hooks).toEqual(
      Object.fromEntries(
        JCODE_HOOK_EVENTS.map((event) => [
          event,
          event === 'pre_tool' ? ['~/gates/pre-tool.sh', guarded] : guarded
        ])
      )
    )
  })

  it('rewrites a remote bare-path install to the guarded command, once per event', async () => {
    const remoteScript = '/home/dev/.orca/agent-hooks/jcode-hook.sh'
    const legacy = tomlQuoteString(`'${remoteScript}'`)
    const { sftp, fs } = createAgentHookMemorySftp({
      '/home/dev/.jcode/config.toml': `[hooks]\n${JCODE_HOOK_EVENTS.map((event) => `${event} = [${legacy}, ${legacy}]`).join('\n')}\n`
    })

    const status = await new JcodeHookService().installRemote(sftp, '/home/dev')

    expect(status.state).toBe('installed')
    expect(parseToml(fs.files.get('/home/dev/.jcode/config.toml') ?? '').hooks).toEqual(
      Object.fromEntries(
        JCODE_HOOK_EVENTS.map((event) => [event, [getJcodeRemoteManagedCommand(remoteScript)]])
      )
    )
  })
})
