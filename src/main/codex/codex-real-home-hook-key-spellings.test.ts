import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

const { homedirMock, grantMock, findCurrentMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  grantMock: vi.fn(),
  findCurrentMock: vi.fn()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

vi.mock('./codex-hook-trust-grant', () => ({
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS: 300_000,
  findCurrentManagedCodexHookTrust: findCurrentMock,
  grantManagedCodexHookTrust: grantMock
}))

import {
  ensureRealHomeCodexHookState,
  removeRealHomeCodexHookForOptOut,
  _internals
} from './codex-real-home-hook-install'
import { getRealHomeHookKeySourcePaths } from './codex-real-home-hooks-json'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { getCodexManagedHookInstallMaterial } from './hook-service'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'

// Why this file: Codex keys ~/.codex/hooks.json as spelled on its default home
// and resolved when CODEX_HOME names it, so a symlinked home has two keys.

let root: string
let home: string
let userDataDir: string
let previousUserDataPath: string | undefined

const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const codexHash = (entry: CodexTrustEntry): string => `sha256:codex-${entry.eventLabel}`

function stopEntry(sourcePath: string, groupIndex = 0): CodexTrustEntry {
  return {
    sourcePath,
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: getCodexManagedHookInstallMaterial().command,
    timeoutSec: 10
  }
}

/** Stands in for Codex: approves the spelled keys it was asked about, and records the ledger. */
function grantLikeCodex(): void {
  grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => {
    const entries = plan.managedEntries.map((entry) => ({
      ...entry,
      trustedHash: codexHash(entry)
    }))
    upsertHookTrustEntries(plan.tomlPath, entries)
    writeCodexTrustGrantLedgerHome(plan.runtimeHomePath, {
      binary: null,
      entries: Object.fromEntries(
        entries.map((entry) => [
          normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
          { signature: getCodexHookTrustSignature(entry), trustedHash: entry.trustedHash }
        ])
      )
    })
    return { lane: 'rpc', entries }
  })
}

async function ensureSettled(): Promise<string> {
  await ensureRealHomeCodexHookState({
    hooksEnabled: true,
    userDataPath: userDataDir,
    writePolicy: 'add-missing-only'
  })
  return _internals.settledVerdictForTesting()
}

function linkCodexHomeToDotfiles(): string {
  const target = join(home, 'dotfiles-codex')
  mkdirSync(target)
  symlinkSync(target, codexHome(), process.platform === 'win32' ? 'junction' : 'dir')
  return join(realpathSync.native(target), 'hooks.json')
}

beforeEach(() => {
  grantMock.mockReset()
  findCurrentMock.mockReset()
  findCurrentMock.mockResolvedValue(null)
  // Why realpath: the temp dir itself may sit under a symlink (macOS /var), which
  // would give every home in this file a second spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-real-home-spellings-')))
  home = join(root, 'home')
  mkdirSync(home)
  userDataDir = join(root, 'user-data')
  mkdirSync(userDataDir)
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(home)
  _internals.resetForTesting('pending')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('both spellings of a symlinked ~/.codex', () => {
  it('has one key when nothing on the path is a symlink', () => {
    mkdirSync(codexHome())

    expect(getRealHomeHookKeySourcePaths()).toEqual([normalizeCodexHookSourcePath(hooksPath())])
  })

  it('resolves the key through a symlinked HOME before ~/.codex exists', () => {
    const linkedHome = join(root, 'linked-home')
    symlinkSync(home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    homedirMock.mockReturnValue(linkedHome)

    expect(getRealHomeHookKeySourcePaths()).toEqual([
      normalizeCodexHookSourcePath(join(linkedHome, '.codex', 'hooks.json')),
      normalizeCodexHookSourcePath(join(home, '.codex', 'hooks.json'))
    ])
    expect(getCodexExplicitHomeHookSourcePath(join(linkedHome, '.codex', 'hooks.json'))).toBe(
      normalizeCodexHookSourcePath(join(home, '.codex', 'hooks.json'))
    )
  })

  it("copies Codex's approval to the resolved key, and the opt-out removes both", async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    grantLikeCodex()

    expect(await ensureSettled()).toBe('installed')

    const spelled = stopEntry(hooksPath())
    const resolved = stopEntry(resolvedHooks)
    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(spelled))?.trustedHash).toBe(codexHash(spelled))
    expect(trust.get(computeTrustKey(resolved))?.trustedHash).toBe(codexHash(spelled))

    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')

    const after = readHookTrustEntries(tomlPath())
    expect(after.get(computeTrustKey(spelled))).toBeUndefined()
    expect(after.get(computeTrustKey(resolved))).toBeUndefined()
  })

  it('copies the approval when an earlier grant is still current, with no session', async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    findCurrentMock.mockImplementation(async (plan: CodexManagedTrustGrantPlan) =>
      plan.managedEntries.map((entry) => ({ ...entry, trustedHash: codexHash(entry) }))
    )

    expect(await ensureSettled()).toBe('installed')

    expect(grantMock).not.toHaveBeenCalled()
    expect(
      readHookTrustEntries(tomlPath()).get(computeTrustKey(stopEntry(resolvedHooks)))?.trustedHash
    ).toBe(codexHash(stopEntry(resolvedHooks)))
  })

  it('moves a user approval under both keys when the opt-out shifts the hook', async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    grantLikeCodex()
    await ensureSettled()
    const installed = JSON.parse(readFileSync(hooksPath(), 'utf-8'))
    installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'after.sh' }] })
    writeFileSync(hooksPath(), `${JSON.stringify(installed, null, 2)}\n`)
    const afterAt = (sourcePath: string, groupIndex: number): CodexTrustEntry => ({
      sourcePath,
      eventLabel: 'stop',
      groupIndex,
      handlerIndex: 0,
      command: 'after.sh'
    })
    upsertHookTrustEntries(tomlPath(), [
      { ...afterAt(hooksPath(), 1), trustedHash: 'sha256:user-spelled' },
      { ...afterAt(resolvedHooks, 1), trustedHash: 'sha256:user-resolved' }
    ])

    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')

    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(afterAt(hooksPath(), 0)))?.trustedHash).toBe(
      'sha256:user-spelled'
    )
    expect(trust.get(computeTrustKey(afterAt(resolvedHooks, 0)))?.trustedHash).toBe(
      'sha256:user-resolved'
    )
    expect(trust.get(computeTrustKey(afterAt(resolvedHooks, 1)))).toBeUndefined()
  })

  it("sweeps a retired hook's approval under both keys", async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    const retired = `/bin/sh "${join(home, 'old-user-data', 'agent-hooks', 'codex-hook.sh')}"`
    writeFileSync(
      hooksPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: retired }] }] } })}\n`
    )
    const retiredAt = (sourcePath: string): CodexTrustEntry => ({
      sourcePath,
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: retired
    })
    upsertHookTrustEntries(tomlPath(), [retiredAt(hooksPath()), retiredAt(resolvedHooks)])

    await cleanupLegacyManagedHookRepresentations()

    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(retiredAt(hooksPath())))).toBeUndefined()
    expect(trust.get(computeTrustKey(retiredAt(resolvedHooks)))).toBeUndefined()
  })

  it('keeps the lane and the file when the copy would break config.toml', async () => {
    linkCodexHomeToDotfiles()
    // Why no write: Codex keeps its own approval in this inline form, which an
    // appended [hooks.state."k"] table would turn into a file Codex cannot load.
    const original = 'model = "m"\nhooks = { state = {} }\n'
    writeFileSync(tomlPath(), original)
    grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => ({
      lane: 'rpc',
      entries: plan.managedEntries.map((entry) => ({ ...entry, trustedHash: codexHash(entry) }))
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await ensureSettled()).toBe('installed')

    expect(readFileSync(tomlPath(), 'utf-8')).toBe(original)
    expect(warn).toHaveBeenCalledWith(
      '[codex-real-home-hooks] could not approve the resolved ~/.codex key:',
      expect.objectContaining({ name: 'CodexConfigTomlRefusedError' })
    )
  })
})
