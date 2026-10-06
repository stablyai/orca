import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})

import { CodexHookService, getCodexManagedHookInstallMaterial } from './hook-service'
import {
  _internals as realHomeInternals,
  ensureRealHomeCodexHookState
} from './codex-real-home-hook-install'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import {
  resolveStartupManagedHookAction,
  shouldInstallStartupManagedAgentHook
} from '../agent-hooks/managed-agent-hook-controls'

// Why this file: every Orca on one HOME shares the current entry in ~/.codex.
// Opening any pane once stripped it (4139 -> 18 bytes) and its trust; only the
// user's explicit opt-out may remove it now.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK = { type: 'command', command: 'user-stop-hook.sh' }

function systemCodexHome(): string {
  return join(homes.tmpHome, '.codex')
}

/** The real home as the real-home lane (or another Orca) leaves it, trust and ledger included. */
function seedSharedEntry(): void {
  const material = getCodexManagedHookInstallMaterial()
  const hooksPath = join(systemCodexHome(), 'hooks.json')
  mkdirSync(systemCodexHome(), { recursive: true })
  writeFileSync(
    hooksPath,
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [USER_HOOK] },
            { hooks: [{ type: 'command', command: material.command, timeout: 10 }] }
          ]
        }
      },
      null,
      2
    )}\n`
  )
  const entry: CodexTrustEntry = {
    sourcePath: hooksPath,
    eventLabel: 'stop',
    groupIndex: 1,
    handlerIndex: 0,
    command: material.command,
    timeoutSec: 10,
    trustedHash: 'sha256:codex-granted-stop'
  }
  writeFileSync(join(systemCodexHome(), 'config.toml'), 'model = "user-model"\n')
  upsertHookTrustEntries(join(systemCodexHome(), 'config.toml'), [entry])
  writeCodexTrustGrantLedgerHome(systemCodexHome(), {
    binary: null,
    entries: {
      [normalizeHookTrustKeyForLookup(computeTrustKey(entry))]: {
        signature: getCodexHookTrustSignature(entry),
        trustedHash: 'sha256:codex-granted-stop'
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

describe('the shared real-home Codex entry', () => {
  it('survives a pane spawn under a managed account, with no .bak', async () => {
    seedSharedEntry()
    const before = snapshotRealCodexHome()
    const accountHome = join(homes.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(accountHome, { recursive: true })

    const status = await new CodexHookService().prepareRuntimeHomeForLaunch(
      accountHome,
      undefined,
      () => true,
      false
    )

    expect(status.state).toBe('installed')
    expect(snapshotRealCodexHome()).toEqual(before)
  })

  it('survives launch prep on the real-home lane with hooks off', async () => {
    seedSharedEntry()
    realHomeInternals.resetForTesting('installed')
    const before = snapshotRealCodexHome()

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: false,
        userDataPath: homes.userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('removed')

    expect(snapshotRealCodexHome()).toEqual(before)
  })

  it('survives a startup with hooks off and its first pane launch prep', async () => {
    seedSharedEntry()
    const before = snapshotRealCodexHome()
    const settings = { agentStatusHooksEnabled: false, disabledTuiAgents: [] }

    // Startup: the real-home install and the managed installs are both skipped.
    expect(resolveStartupManagedHookAction(settings)).toBe('skip')
    expect(shouldInstallStartupManagedAgentHook(settings, 'codex')).toBe(false)
    // First pane: both lanes run with hooks off.
    await ensureRealHomeCodexHookState({
      hooksEnabled: false,
      userDataPath: homes.userDataDir,
      writePolicy: 'add-missing-only'
    })
    await new CodexHookService().prepareRuntimeHomeForLaunch(
      getOrcaManagedCodexHomePath(),
      undefined,
      () => false,
      false
    )

    expect(snapshotRealCodexHome()).toEqual(before)
  })

  it("is removed, with Orca's trust, only by the user's explicit opt-out", async () => {
    seedSharedEntry()

    await new CodexHookService().remove()

    const hooks = JSON.parse(readFileSync(join(systemCodexHome(), 'hooks.json'), 'utf-8'))
    expect(hooks.hooks.Stop).toEqual([{ hooks: [USER_HOOK] }])
    const toml = readFileSync(join(systemCodexHome(), 'config.toml'), 'utf-8')
    expect(toml).toContain('model = "user-model"')
    expect(toml).not.toContain(':stop:1:0')
  })
})
