import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolytokenHookService } from './hook-service'
import { POLYTOKEN_HOOK_EVENTS } from './polytoken-hooks-json'
import {
  resolvePolytokenHooksJsonPath,
  resolveRemotePolytokenHooksJsonPath
} from './polytoken-config-paths'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and the hooks.json path
// honors XDG_CONFIG_HOME; point both at a temp dir so the real ~/.config/polytoken is untouched.
let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-polytoken-hook-'))
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) {
    saved[key] = process.env[key]
  }
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.config', 'polytoken', 'hooks.json')
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', 'polytoken-hook.sh')
const readEntries = (): Record<string, unknown>[] =>
  JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>[]

describe('polytoken config paths', () => {
  it('honors XDG_CONFIG_HOME and falls back to ~/.config', () => {
    expect(resolvePolytokenHooksJsonPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe(
      '/x/cfg/polytoken/hooks.json'
    )
    expect(resolvePolytokenHooksJsonPath({}, '/home/u')).toBe(
      '/home/u/.config/polytoken/hooks.json'
    )
    // Why: the XDG contract requires an absolute path; anything else must not redirect the write.
    for (const relative of ['cfg', './cfg', '../cfg', '  ']) {
      expect(resolvePolytokenHooksJsonPath({ XDG_CONFIG_HOME: relative }, '/home/u')).toBe(
        '/home/u/.config/polytoken/hooks.json'
      )
    }
    expect(resolveRemotePolytokenHooksJsonPath('/home/remote')).toBe(
      '/home/remote/.config/polytoken/hooks.json'
    )
  })
})

describe('PolytokenHookService', () => {
  it('reports not_installed before install', () => {
    expect(new PolytokenHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed script and one silent handler per registered event', () => {
    const status = new PolytokenHookService().install()
    expect(status).toMatchObject({
      agent: 'polytoken',
      state: 'installed',
      managedHooksPresent: true
    })

    const entries = readEntries()
    expect(entries.map((entry) => entry.event)).toEqual([...POLYTOKEN_HOOK_EVENTS])
    const handler = (entries[0].handler as { bash: string }).bash
    expect(handler).toContain(scriptPath())
    // Why: sessions Orca did not launch must not spawn the script, and the fallback must stay silent.
    expect(handler).toContain('[ -n "$ORCA_PANE_KEY" ]')
    expect(handler).not.toContain('printf')

    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/polytoken')
    expect(script.trimEnd().endsWith('exit 0')).toBe(true)
  })

  it('is idempotent and preserves foreign entries while repairing legacy Orca entries', () => {
    mkdirSync(join(home, '.config', 'polytoken'), { recursive: true })
    const foreign = [
      { name: 'orca-pi-bridge-stop', event: 'stop', handler: { bash: 'bridge.sh' } },
      { name: 'orca-managed-stop', event: 'stop', handler: { bash: '/bin/sh old.sh' } }
    ]
    writeFileSync(configPath(), JSON.stringify(foreign, null, 2))

    const service = new PolytokenHookService()
    expect(service.install().state).toBe('installed')
    const first = readFileSync(configPath(), 'utf-8')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath(), 'utf-8')).toBe(first)

    const entries = readEntries()
    expect(entries[0]).toEqual(foreign[0])
    expect(entries.some((entry) => entry.name === 'orca-managed-stop')).toBe(false)

    expect(service.remove().state).toBe('not_installed')
    expect(readEntries()).toEqual([foreign[0]])
  })

  it('reports partial state when a managed handler was edited away', () => {
    const service = new PolytokenHookService()
    service.install()
    const entries = readEntries()
    entries.at(-1)!.handler = { bash: 'something-else.sh' }
    writeFileSync(configPath(), JSON.stringify(entries))
    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      detail: expect.stringContaining('stop')
    })
  })

  it('fails closed on a hooks.json it cannot round-trip', () => {
    mkdirSync(join(home, '.config', 'polytoken'), { recursive: true })
    writeFileSync(configPath(), '{"hooks": []}')
    const service = new PolytokenHookService()
    expect(service.install()).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('array')
    })
    expect(readFileSync(configPath(), 'utf-8')).toBe('{"hooks": []}')
    expect(service.remove().state).toBe('error')
  })

  it('reads and writes under XDG_CONFIG_HOME when it is set', () => {
    process.env.XDG_CONFIG_HOME = join(home, 'xdg')
    const status = new PolytokenHookService().install()
    expect(status.configPath).toBe(join(home, 'xdg', 'polytoken', 'hooks.json'))
    expect(readFileSync(status.configPath, 'utf-8')).toContain(
      'orca-managed-polytoken-session_start'
    )
  })

  it('surfaces an unreadable file as an error without touching it', () => {
    mkdirSync(join(home, '.config', 'polytoken'), { recursive: true })
    writeFileSync(configPath(), '[]')
    chmodSync(configPath(), 0o000)
    try {
      expect(new PolytokenHookService().getStatus().state).toBe(
        process.getuid?.() === 0 ? 'not_installed' : 'error'
      )
    } finally {
      chmodSync(configPath(), 0o600)
    }
  })
})
