import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { JcodeHookService } from './hook-service'
import { getJcodeConfigPath, getJcodeManagedScriptPath } from './hook-settings'

describe('JcodeHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-home-'))
    homedirMock.mockReturnValue(homeDir)
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
    for (const event of ['turn_end', 'session_start', 'session_end', 'post_tool']) {
      expect(config).toContain(`${event} = "${getJcodeManagedScriptPath()}"`)
    }
    const script = readFileSync(getJcodeManagedScriptPath(), 'utf8')
    expect(script).toContain('/hook/jcode')
    expect(script).toContain('payload@-')
    // Why: the payload is jcode's own JCODE_HOOK_PAYLOAD, forwarded verbatim.
    expect(script).toContain('$JCODE_HOOK_PAYLOAD')
    expect(script).toContain('hook_event_name=${JCODE_HOOK_EVENT}')
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
    const after = readFileSync(getJcodeConfigPath(), 'utf8')
    expect(after).not.toContain(getJcodeManagedScriptPath())
  })
})
