import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntriesFromContent,
  type CodexTrustEntry
} from './config-toml-trust'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

// Why a retired form: the sweep removes only commands no current build writes.
function retiredManagedHookCommand(): string {
  if (process.platform === 'win32') {
    return join(homes.userDataDir, 'agent-hooks', 'codex-hook.cmd')
  }
  const quoted = `'${join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
}

type Seeded = {
  hooksPath: string
  tomlPath: string
  hooks: string
  toml: string
  userAtOne: CodexTrustEntry
  userAtZero: CodexTrustEntry
  retired: CodexTrustEntry
}

function trustBlock(entry: CodexTrustEntry): string {
  return [
    `[hooks.state."${computeTrustKey(entry).replaceAll('\\', '\\\\')}"]`,
    `trusted_hash = "${computeTrustedHash(entry)}"`
  ].join('\n')
}

/** A retired Orca entry ahead of a user hook, both trusted, in a config.toml headed by `firstLine`. */
function seedRetiredEntryAheadOfUserHook(firstLine: string): Seeded {
  const systemCodexHome = join(homes.tmpHome, '.codex')
  const hooksPath = join(systemCodexHome, 'hooks.json')
  const tomlPath = join(systemCodexHome, 'config.toml')
  mkdirSync(systemCodexHome, { recursive: true })
  const userHook = { type: 'command', command: 'user-stop-hook', timeout: 30 }
  const hooks = `${JSON.stringify(
    {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: retiredManagedHookCommand() }] },
          { hooks: [userHook] }
        ]
      }
    },
    null,
    2
  )}\n`
  writeFileSync(hooksPath, hooks, 'utf-8')
  const base = { sourcePath: hooksPath, eventLabel: 'stop' as const, handlerIndex: 0 }
  const retired = { ...base, groupIndex: 0, command: retiredManagedHookCommand() }
  const userAtOne = { ...base, groupIndex: 1, command: userHook.command, timeoutSec: 30 }
  const toml = [firstLine, '', trustBlock(retired), '', trustBlock(userAtOne), ''].join('\n')
  writeFileSync(tomlPath, toml, 'utf-8')
  return {
    hooksPath,
    tomlPath,
    hooks,
    toml,
    userAtOne,
    userAtZero: { ...userAtOne, groupIndex: 0 },
    retired
  }
}

function warnings(warn: ReturnType<typeof vi.spyOn>, text: string): unknown[][] {
  return warn.mock.calls.filter(
    ([message]) => typeof message === 'string' && message.includes(text)
  )
}

const HOOK_SETTINGS = [
  ['hooks on', true],
  ['hooks off', false]
] as const

// Why: the managed mirror copies a hand-broken ~/.codex/config.toml, so its trust
// write is refused first; the ~/.codex sweep must still run, and while the trust it
// shifts cannot move, it must wait rather than strand the user's approval.
describe('CodexHookService retired-entry sweep while config.toml is unreadable', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it.each(HOOK_SETTINGS)('with %s, waits and logs once', async (_label, hooksEnabled) => {
    // Why `model =`: a hand-broken line no repair may touch.
    const seeded = seedRetiredEntryAheadOfUserHook('model =')
    const service = new CodexHookService()

    for (let launch = 0; launch < 2; launch++) {
      const status = await service.prepareRuntimeHomeForLaunch(undefined, undefined, hooksEnabled)
      expect(status.state).toBe('error')
      expect(status.detail).not.toContain('..')
      expect(status.detail).not.toContain('Run /hooks')
    }

    expect(readFileSync(seeded.hooksPath, 'utf-8')).toBe(seeded.hooks)
    expect(readFileSync(seeded.tomlPath, 'utf-8')).toBe(seeded.toml)
    expect(warnings(warn, 'Waiting to remove retired Orca hook entries')).toHaveLength(1)
    expect(warnings(warn, 'failed to clean legacy Codex hooks')).toHaveLength(0)
  })

  it.each(HOOK_SETTINGS)(
    'with %s, sweeps and moves the approval once the file is fixed',
    async (_label, hooksEnabled) => {
      const seeded = seedRetiredEntryAheadOfUserHook('model =')
      const service = new CodexHookService()
      await service.prepareRuntimeHomeForLaunch(undefined, undefined, hooksEnabled)

      writeFileSync(seeded.tomlPath, seeded.toml.replace('model =', 'model = "gpt-5"'), 'utf-8')
      await service.prepareRuntimeHomeForLaunch(undefined, undefined, hooksEnabled)

      expect(JSON.parse(readFileSync(seeded.hooksPath, 'utf-8'))).toMatchObject({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook', timeout: 30 }] }] }
      })
      const toml = readFileSync(seeded.tomlPath, 'utf-8')
      const trust = readHookTrustEntriesFromContent(toml)
      expect(trust.get(computeTrustKey(seeded.userAtZero))?.trustedHash).toBe(
        computeTrustedHash(seeded.userAtOne)
      )
      expect(trust.has(computeTrustKey(seeded.userAtOne))).toBe(false)
      expect(toml).not.toContain(computeTrustedHash(seeded.retired))
    }
  )
})
