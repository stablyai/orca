import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, deriveCodexHookFlagEntryMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  deriveCodexHookFlagEntryMock: vi.fn(async () => null)
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
// Why: deriving the flags spawns the machine's real codex.
vi.mock('./codex-hook-session-trust', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deriveCodexHookFlagEntry: deriveCodexHookFlagEntryMock
}))

import { CodexHookService, getCodexManagedHookInstallMaterial } from './hook-service'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import {
  resolveStartupManagedHookAction,
  shouldInstallStartupManagedAgentHook
} from '../agent-hooks/managed-agent-hook-controls'

// Why this file: opening any pane once stripped ~/.codex (4139 -> 18 bytes).
// Orca's hook now rides each launch as a session flag, so launch prep and pane
// spawns never touch ~/.codex; only app start (hooks on) and the opt-out strip
// an older build's entry there, keeping the user's approvals on their hooks.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK = { type: 'command', command: 'user-stop-hook.sh' }
const USER_HASH = 'sha256:user-approved-stop'
const ORCA_HASH = 'sha256:codex-granted-stop'

function systemCodexHome(): string {
  return join(homes.tmpHome, '.codex')
}

function systemHooksPath(): string {
  return join(systemCodexHome(), 'hooks.json')
}

function systemTomlPath(): string {
  return join(systemCodexHome(), 'config.toml')
}

function stopTrustKey(groupIndex: number, command: string): string {
  return normalizeHookTrustKeyForLookup(
    computeTrustKey({
      sourcePath: systemHooksPath(),
      eventLabel: 'stop',
      groupIndex,
      handlerIndex: 0,
      command
    })
  )
}

/**
 * ~/.codex as an older Orca left it: its entry ahead of the user's approved
 * hook, with Orca's trust and ledger.
 */
function seedOlderBuildEntry(): void {
  const material = getCodexManagedHookInstallMaterial()
  mkdirSync(systemCodexHome(), { recursive: true })
  writeFileSync(
    systemHooksPath(),
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: material.command, timeout: 10 }] },
            { hooks: [USER_HOOK] }
          ]
        }
      },
      null,
      2
    )}\n`
  )
  const orcaEntry: CodexTrustEntry = {
    sourcePath: systemHooksPath(),
    eventLabel: 'stop',
    groupIndex: 0,
    handlerIndex: 0,
    command: material.command,
    timeoutSec: 10,
    trustedHash: ORCA_HASH
  }
  const userEntry: CodexTrustEntry = {
    sourcePath: systemHooksPath(),
    eventLabel: 'stop',
    groupIndex: 1,
    handlerIndex: 0,
    command: USER_HOOK.command,
    trustedHash: USER_HASH
  }
  writeFileSync(systemTomlPath(), 'model = "user-model"\n')
  upsertHookTrustEntries(systemTomlPath(), [orcaEntry, userEntry])
  writeCodexTrustGrantLedgerHome(systemCodexHome(), {
    binary: null,
    entries: {
      [normalizeHookTrustKeyForLookup(computeTrustKey(orcaEntry))]: {
        signature: getCodexHookTrustSignature(orcaEntry),
        trustedHash: ORCA_HASH
      }
    }
  })
}

function snapshotRealCodexHome(): Map<string, { bytes: string; mtimeMs: number }> {
  return new Map(
    readdirSync(systemCodexHome()).map((name) => {
      const path = join(systemCodexHome(), name)
      return [name, { bytes: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs }]
    })
  )
}

function expectOrcaEntryStrippedAndUserTrustMoved(): void {
  const hooks = JSON.parse(readFileSync(systemHooksPath(), 'utf-8'))
  expect(hooks.hooks.Stop).toEqual([{ hooks: [USER_HOOK] }])
  const toml = readFileSync(systemTomlPath(), 'utf-8')
  expect(toml).toContain('model = "user-model"')
  expect(toml).not.toContain(ORCA_HASH)
  const trust = new Map(
    [...readHookTrustEntries(systemTomlPath())].map(([key, state]) => [
      normalizeHookTrustKeyForLookup(key),
      state
    ])
  )
  expect(trust.get(stopTrustKey(0, USER_HOOK.command))?.trustedHash).toBe(USER_HASH)
  expect(trust.has(stopTrustKey(1, USER_HOOK.command))).toBe(false)
  expect(trust.size).toBe(1)
}

describe('the real ~/.codex under session-flag hooks', () => {
  it('is untouched by a pane spawn under a managed account, with no .bak', async () => {
    seedOlderBuildEntry()
    const before = snapshotRealCodexHome()
    const accountHome = join(homes.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(accountHome, { recursive: true })

    const status = await new CodexHookService().prepareRuntimeHomeForLaunch(
      accountHome,
      undefined,
      true
    )

    expect(status.state).not.toBe('error')
    expect(snapshotRealCodexHome()).toEqual(before)
    // The account home mirrors the user's hook without Orca's entry.
    const accountHooks = readFileSync(join(accountHome, 'hooks.json'), 'utf-8')
    expect(JSON.parse(accountHooks).hooks.Stop).toEqual([{ hooks: [USER_HOOK] }])
    expect(accountHooks).not.toContain('codex-hook.')
  })

  it('is untouched by launch prep of the shared managed home with hooks on or off', async () => {
    seedOlderBuildEntry()
    const before = snapshotRealCodexHome()
    const service = new CodexHookService()

    await service.prepareRuntimeHomeForLaunch(getOrcaManagedCodexHomePath(), undefined, true)
    await service.prepareRuntimeHomeForLaunch(getOrcaManagedCodexHomePath(), undefined, false)
    await service.refreshRuntimeUserHooksForLaunchPrep()

    expect(snapshotRealCodexHome()).toEqual(before)
  })

  it('is untouched by a startup with hooks off and its first pane launch prep', async () => {
    seedOlderBuildEntry()
    const before = snapshotRealCodexHome()
    const settings = { agentStatusHooksEnabled: false, disabledTuiAgents: [] }

    // Startup: the managed installs, including installSessionFlags, are skipped.
    expect(resolveStartupManagedHookAction(settings)).toBe('skip')
    expect(shouldInstallStartupManagedAgentHook(settings, 'codex')).toBe(false)
    await new CodexHookService().prepareRuntimeHomeForLaunch(
      getOrcaManagedCodexHomePath(),
      undefined,
      false
    )

    expect(snapshotRealCodexHome()).toEqual(before)
    expect(deriveCodexHookFlagEntryMock).not.toHaveBeenCalled()
  })

  it("loses an older build's entry and trust at app start, keeping the user's approval", async () => {
    seedOlderBuildEntry()

    await new CodexHookService().installSessionFlags()

    expectOrcaEntryStrippedAndUserTrustMoved()
  })

  it('leaves a ~/.codex with no Orca entry byte-identical at app start', async () => {
    mkdirSync(systemCodexHome(), { recursive: true })
    writeFileSync(
      systemHooksPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [USER_HOOK] }] } })}\n`
    )
    writeFileSync(systemTomlPath(), 'model = "user-model"\n')
    const before = snapshotRealCodexHome()

    await new CodexHookService().installSessionFlags()

    expect(snapshotRealCodexHome()).toEqual(before)
  })

  it("loses an older build's entry and trust on the user's explicit opt-out", async () => {
    seedOlderBuildEntry()

    await new CodexHookService().remove()

    expectOrcaEntryStrippedAndUserTrustMoved()
  })
})
