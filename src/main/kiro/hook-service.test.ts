import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createManagedHookLocalFilesystem } from '../agent-hooks/installation/remote/testing/managed-hook-local-filesystem.test-fixture'
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { KiroHookService } from './hook-service'
import { getKiroManagedCommandMatcher, KIRO_HOOK_EVENTS } from './hook-settings'

// Isolate HOME and USERPROFILE so tests cannot write real Kiro or Orca configs on any OS.
let home: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalKiroHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kiro-hook-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  originalKiroHome = process.env.KIRO_HOME
  delete process.env.KIRO_HOME
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  if (originalKiroHome === undefined) {
    delete process.env.KIRO_HOME
  } else {
    process.env.KIRO_HOME = originalKiroHome
  }
  rmSync(home, { recursive: true, force: true })
})

const agentsDir = (): string => join(home, '.kiro', 'agents')
const agentPath = (name: string): string => join(agentsDir(), `${name}.json`)

function writeAgent(name: string, config: unknown): void {
  mkdirSync(agentsDir(), { recursive: true })
  writeFileSync(agentPath(name), `${JSON.stringify(config, null, 2)}\n`)
}

function readAgent(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(agentPath(name), 'utf-8'))
}

const USER_STOP_HOOK = { command: 'say done' }

describe('KiroHookService', () => {
  it('adds one managed hook per event to every agent and keeps user hooks', () => {
    writeAgent('caverna', { name: 'caverna', tools: ['*'], hooks: { stop: [USER_STOP_HOOK] } })
    writeAgent('reviewer', { name: 'reviewer', tools: ['read'] })

    const service = new KiroHookService()
    expect(service.install().state).toBe('installed')
    expect(service.install().state).toBe('installed')

    const caverna = readAgent('caverna')
    expect(caverna.tools).toEqual(['*'])
    const hooks = caverna.hooks
    if (!isPlainObject(hooks)) {
      throw new Error('Expected hooks object')
    }
    expect(Object.keys(hooks).sort()).toEqual([...KIRO_HOOK_EVENTS].sort())
    const isManaged = getKiroManagedCommandMatcher()
    for (const event of KIRO_HOOK_EVENTS) {
      const entries = hooks[event]
      if (!Array.isArray(entries)) {
        throw new Error('Expected hook array')
      }
      expect(
        entries.filter((entry) => isPlainObject(entry) && isManaged(String(entry.command)))
      ).toHaveLength(1)
    }
    expect(hooks.stop).toEqual([
      USER_STOP_HOOK,
      expect.objectContaining({ command: expect.any(String) })
    ])
    expect(hooks.preToolUse).toEqual([expect.objectContaining({ matcher: '*' })])
    expect(readAgent('reviewer').hooks).toBeDefined()
  })

  it('reports partial when an agent file cannot be parsed and leaves it untouched', () => {
    writeAgent('good', { name: 'good' })
    mkdirSync(agentsDir(), { recursive: true })
    writeFileSync(agentPath('broken'), '{ not json')

    const result = new KiroHookService().install()
    expect(result.state).toBe('partial')
    expect(result.detail).toContain('broken.json is not valid JSON')
    expect(readFileSync(agentPath('broken'), 'utf-8')).toBe('{ not json')
  })

  // Shape `kiro-cli agent upgrade` (2.29+) writes; edits to `hooks` keep the file "universal".
  it('converges list-form hooks in place and removes only its entries, locally and remotely', async () => {
    const orcaHook = (trigger: string, command: string) => ({
      name: `${trigger}-0`,
      trigger,
      ...(trigger === 'preToolUse' ? { matcher: '*' } : {}),
      action: { type: 'command', command },
      timeout: 10
    })
    const userHook = {
      name: 'preToolUse-0',
      trigger: 'preToolUse',
      matcher: 'execute_bash',
      action: { type: 'command', command: 'audit.sh' },
      timeout: 10
    }
    const stale = `/bin/sh '${join(home, '.orca', 'agent-hooks', 'kiro-hook.sh')}'`
    const extra = {
      permissions: { rules: [{ capability: 'shell', effect: 'allow' }] },
      kiroUpgrade: { notes: [] }
    }
    writeAgent('reviewer', {
      name: 'reviewer',
      hooks: [orcaHook('agentSpawn', stale), userHook, orcaHook('preToolUse', stale)],
      ...extra
    })
    writeAgent('upgraded', { name: 'upgraded', permissions: extra.permissions })

    const service = new KiroHookService()
    expect(service.getStatus()).toMatchObject({ state: 'partial', managedHooksPresent: true })
    expect(service.install().state).toBe('installed')
    const installed = readAgent('reviewer')
    const hooks = installed.hooks
    if (!Array.isArray(hooks)) {
      throw new Error('Expected hooks list')
    }
    expect(hooks.map((hook) => hook.trigger)).toEqual([
      'agentSpawn',
      'preToolUse',
      'preToolUse',
      'userPromptSubmit',
      'postToolUse',
      'stop'
    ])
    expect(hooks[1]).toEqual(userHook)
    expect(hooks[2]).toMatchObject({ matcher: '*', timeout: 10, action: { type: 'command' } })
    expect(hooks.filter((hook) => hook.action.command === stale)).toEqual([])
    expect(installed).toMatchObject(extra)
    expect(readAgent('upgraded').hooks).toHaveLength(KIRO_HOOK_EVENTS.length)

    expect(service.remove().state).toBe('not_installed')
    expect(readAgent('reviewer')).toEqual({ name: 'reviewer', hooks: [userHook], ...extra })
    expect(readAgent('upgraded')).toEqual({ name: 'upgraded', permissions: extra.permissions })

    expect(await service.installRemote(createManagedHookLocalFilesystem(), home)).toMatchObject({
      state: 'installed'
    })
    expect(readAgent('reviewer').hooks).toHaveLength(KIRO_HOOK_EVENTS.length + 1)
  })

  it.each([
    { hooks: ['say done'] },
    { hooks: 'keep this' },
    { hooks: { stop: { command: 'say done' } } }
  ])(
    'preserves unsupported user hook structures and reports them locally and remotely: %j',
    async ({ hooks }) => {
      writeAgent('unsupported', { name: 'unsupported', hooks })
      const original = readFileSync(agentPath('unsupported'), 'utf-8')
      const service = new KiroHookService()
      expect(service.install()).toMatchObject({ state: 'error' })
      expect(readFileSync(agentPath('unsupported'), 'utf-8')).toBe(original)
      expect(await service.installRemote(createManagedHookLocalFilesystem(), home)).toMatchObject({
        state: 'error'
      })
      expect(readFileSync(agentPath('unsupported'), 'utf-8')).toBe(original)
    }
  )

  it('removes only managed hooks and drops the hooks block it emptied', () => {
    writeAgent('caverna', { name: 'caverna', hooks: { stop: [USER_STOP_HOOK] } })
    writeAgent('plain', { name: 'plain' })
    const service = new KiroHookService()
    service.install()

    expect(service.remove().state).toBe('not_installed')
    expect(readAgent('caverna').hooks).toEqual({ stop: [USER_STOP_HOOK] })
    expect(readAgent('plain')).toEqual({ name: 'plain' })
  })

  it('patches the remote agents under the probed KIRO_HOME, not ~/.kiro', async () => {
    const kiroHome = join(home, 'remote-kiro')
    mkdirSync(join(kiroHome, 'agents'), { recursive: true })
    writeFileSync(join(kiroHome, 'agents', 'remote.json'), JSON.stringify({ name: 'remote' }))
    writeAgent('stale', { name: 'stale' })

    const result = await new KiroHookService().installRemote(
      createManagedHookLocalFilesystem(),
      home,
      kiroHome
    )

    expect(result.state).toBe('installed')
    const remote = JSON.parse(readFileSync(join(kiroHome, 'agents', 'remote.json'), 'utf-8'))
    expect(Object.keys(remote.hooks).sort()).toEqual([...KIRO_HOOK_EVENTS].sort())
    expect(readAgent('stale').hooks).toBeUndefined()
  })

  // Check command shapes everywhere; windows-hook-payload-delivery.test.ts executes them under Kiro's shells.
})
