import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { upsertHookTrustEntries, type CodexTrustEntry } from '../../trust/toml/config-toml-trust'
import {
  computeCodexTrustKey as computeTrustKey,
  normalizeCodexHookTrustLookupKey as normalizeHookTrustKeyForLookup
} from '../../trust/identity/codex-trust-identity'
import { writeCodexTrustGrantLedgerHome } from '../../trust/grants/codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from '../definitions/codex-hook-identity'
import { setupCodexHookHomes } from '../installation/hook-service-test-harness'
import { _internals as lookupInternals } from '../../trust/hooks/codex-hook-hash-lookup'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})

import '../installation/hook-service'
import { CodexHookService } from '../installation/codex-hook-service-implementation'
import {
  getCodexManagedHookInstallMaterial,
  getCodexManagedHookStatusMessage
} from '../definitions/codex-hook-definition'
import {
  _internals as reconcileInternals,
  reconcileCodexHooks,
  startCodexHooks
} from './codex-hook-reconcile'

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK = { type: 'command', command: 'user-stop-hook.sh' }

function systemCodexHome(): string {
  return join(homes.tmpHome, '.codex')
}

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
    statusMessage: getCodexManagedHookStatusMessage(material.command),
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

async function reconcileWithHooksOff(): Promise<void> {
  reconcileInternals.resetForTesting()
  startCodexHooks({
    isEnabled: () => false,
    resolveLaunchHome: () => null,
    pathReady: Promise.resolve()
  })
  await reconcileCodexHooks({ convertOlderForms: true, realHomeLaunch: true })
  // Cancel the startup lookup; this fixture supplies no Codex process.
  reconcileInternals.resetForTesting()
  lookupInternals.resetForTesting()
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

  it('survives a reconcile on the real-home lane with hooks off', async () => {
    seedSharedEntry()
    const before = snapshotRealCodexHome()

    await reconcileWithHooksOff()

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
