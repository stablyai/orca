import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { AuggieHookService } from './hook-service'
import { AUGGIE_EVENTS, getConfigPath, getManagedScriptFileName } from './hook-settings'

const SCRIPT_FILE_NAME = process.platform === 'win32' ? 'aug-hook.cmd' : 'aug-hook.sh'

describe('AuggieHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-auggie-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('reports not_installed before install', () => {
    expect(new AuggieHookService().getStatus().state).toBe('not_installed')
  })

  it('writes the managed script before the config, then installs every event', () => {
    const status = new AuggieHookService().install()
    expect(status.state).toBe('installed')
    expect(status.agent).toBe('aug')
    expect(status.configPath).toBe(getConfigPath())
    expect(getManagedScriptFileName()).toBe(SCRIPT_FILE_NAME)

    const scriptPath = join(homeDir, '.orca', 'agent-hooks', SCRIPT_FILE_NAME)
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('/hook/aug')
    expect(script).toContain('printf \'%s\' "$payload" | curl')

    const config = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as {
      hooks: Record<
        string,
        {
          matcher?: string
          hooks: { command: string; timeout: number }[]
          metadata?: Record<string, unknown>
        }[]
      >
    }
    for (const event of AUGGIE_EVENTS) {
      const definition = config.hooks[event.eventName]?.[0]
      expect(definition?.hooks[0]?.command).toBe(scriptPath)
      // Why: Auggie's timeout unit is milliseconds, not the seconds default other agents use.
      expect(definition?.hooks[0]?.timeout).toBe(10_000)
      if (event.needsMatcher) {
        expect(definition?.matcher).toBe('.*')
      }
      if (event.metadata) {
        expect(definition?.metadata).toEqual(event.metadata)
      }
    }
  })

  it('preserves unrelated user config and does not duplicate on reinstall', () => {
    mkdirSync(join(homeDir, '.augment'), { recursive: true })
    const userConfig = JSON.stringify({ userSetting: 'keep-me' })
    writeFileSync(getConfigPath(), userConfig)

    const service = new AuggieHookService()
    expect(service.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as {
      userSetting?: string
      hooks: Record<string, unknown[]>
    }
    expect(installed.userSetting).toBe('keep-me')

    service.install()
    const reinstalled = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(reinstalled.hooks.PreToolUse).toHaveLength(1)
  })

  it('sweeps stale managed entries and removes cleanly', () => {
    const service = new AuggieHookService()
    service.install()
    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    expect(removed.managedHooksPresent).toBe(false)
  })

  it('does not count hooks that do not point at the managed script', () => {
    mkdirSync(join(homeDir, '.augment'), { recursive: true })
    writeFileSync(
      getConfigPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: '/some/other/aug-hook.sh', timeout: 10_000 }] }
          ]
        }
      })
    )
    const status = new AuggieHookService().getStatus()
    expect(status.state).toBe('not_installed')
  })

  it('reports partial when only some events carry the managed hook', () => {
    const service = new AuggieHookService()
    service.install()
    const config = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    delete config.hooks.Stop
    delete config.hooks.SessionEnd
    writeFileSync(getConfigPath(), JSON.stringify(config))

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('Stop')
    expect(status.detail).toContain('SessionEnd')
  })

  it('installs remote hooks over SFTP as a bare absolute script path', async () => {
    const files = new Map<string, string>()
    const modes = new Map<string, number>()
    const sftp = {
      readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void) => {
        const v = files.get(path)
        if (v === undefined) {
          cb({ code: 2 })
        } else {
          cb(null, v)
        }
      },
      writeFile: (
        path: string,
        content: string,
        opts: { mode?: number } | string,
        cb: (err: unknown) => void
      ) => {
        files.set(path, content)
        if (typeof opts !== 'string' && opts.mode !== undefined) {
          modes.set(path, opts.mode)
        }
        cb(null)
      },
      rename: (src: string, dst: string, cb: (err: unknown) => void) => {
        files.set(dst, files.get(src) ?? '')
        files.delete(src)
        const mode = modes.get(src)
        if (mode !== undefined) {
          modes.set(dst, mode)
          modes.delete(src)
        }
        cb(null)
      },
      unlink: (_path: string, cb: (err: unknown) => void) => cb(null),
      chmod: (path: string, mode: number, cb: (err: unknown) => void) => {
        modes.set(path, mode)
        cb(null)
      },
      stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void) => {
        if (files.has(path)) {
          cb(null, { mode: modes.get(path) ?? 0o100600 })
        } else {
          cb({ code: 2 })
        }
      },
      readdir: (_path: string, cb: (err: unknown, list?: unknown[]) => void) => cb(null, []),
      mkdir: (_path: string, cb: (err: unknown) => void) => cb(null)
    } as unknown as SFTPWrapper

    const status = await new AuggieHookService().installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.augment/settings.json')
    const scriptPath = '/home/dev/.orca/agent-hooks/aug-hook.sh'
    expect(files.get(scriptPath)).toContain('/hook/aug')
    expect(modes.get(scriptPath)).toBe(0o755)
    expect(files.get('/home/dev/.augment/settings.json')).toContain(scriptPath)
  })
})
