import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RovoHookService } from './hook-service'

// Why: getSharedManagedScriptPath() and ~/.rovo resolve through homedir(); point it at a temp dir.
let home: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-rovo-hook-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  for (const [key, value] of [
    ['HOME', originalHome],
    ['USERPROFILE', originalUserProfile]
  ] as const) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.rovo', 'config.yml')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'rovo-hook.sh')

describe.skipIf(process.platform === 'win32')('RovoHookService', () => {
  it('installs, reports, and removes managed hooks without touching user hooks', () => {
    mkdirSync(join(home, '.rovo'), { recursive: true })
    const userConfig =
      'eventHooks:\n  events:\n  - name: on_complete\n    commands:\n    - command: echo user\n'
    writeFileSync(configPath(), userConfig)
    const service = new RovoHookService()

    expect(service.getStatus().state).toBe('not_installed')
    expect(service.install()).toMatchObject({ agent: 'rovo', state: 'installed' })
    expect(readFileSync(configPath(), 'utf-8')).toContain('rovo-hook.sh')
    expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe(userConfig)
    expect(readFileSync(scriptPath(), 'utf-8')).toContain('/hook/rovo')

    expect(service.remove().state).toBe('not_installed')
    expect(readFileSync(configPath(), 'utf-8')).toBe(userConfig)
  })

  it('reports an error and leaves an unparseable config untouched', () => {
    mkdirSync(join(home, '.rovo'), { recursive: true })
    writeFileSync(configPath(), 'eventHooks: [oops')
    const status = new RovoHookService().install()

    expect(status.state).toBe('error')
    expect(readFileSync(configPath(), 'utf-8')).toBe('eventHooks: [oops')
  })

  it('answers Rovo with an empty JSON object even when Orca is unreachable', () => {
    new RovoHookService().install()
    const env = { PATH: process.env.PATH ?? '', HOME: home }
    const stdout = execFileSync('/bin/sh', [scriptPath()], {
      input: '{"hook_event_name":"on_complete"}',
      env
    }).toString()
    expect(stdout.trim()).toBe('{}')
  })
})
