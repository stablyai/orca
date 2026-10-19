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
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import {
  reconcileRealHomeCodexHookEntries,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'
import { getRealHomeHookKeySourcePaths } from './codex-real-home-hooks-json'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { getCodexManagedHookInstallMaterial } from './hook-service'

// Why this file: Codex keys ~/.codex/hooks.json as spelled on its default home
// and resolved when CODEX_HOME names it, so a symlinked home has two keys.

let root: string
let home: string
let userDataDir: string
let previousUserDataPath: string | undefined

const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const CODEX_HASHES: CodexHookHashes = { stop: 'sha256:codex-stop' }

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

async function reconcile(): Promise<void> {
  await reconcileRealHomeCodexHookEntries({
    hashes: CODEX_HASHES,
    isEnabled: () => true,
    convertOlderForms: true
  })
}

function linkCodexHomeToDotfiles(): string {
  const target = join(home, 'dotfiles-codex')
  mkdirSync(target)
  symlinkSync(target, codexHome(), process.platform === 'win32' ? 'junction' : 'dir')
  return join(realpathSync.native(target), 'hooks.json')
}

beforeEach(() => {
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
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
  vi.restoreAllMocks()
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

  it("approves under both keys, and the opt-out removes both by Codex's hash", async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()

    await reconcile()

    const spelled = stopEntry(hooksPath())
    const resolved = stopEntry(resolvedHooks)
    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(spelled))).toEqual({
      trustedHash: CODEX_HASHES.stop,
      enabled: true
    })
    expect(trust.get(computeTrustKey(resolved))).toEqual({
      trustedHash: CODEX_HASHES.stop,
      enabled: true
    })
    const approved = readFileSync(tomlPath(), 'utf-8')
    await reconcile()
    expect(readFileSync(tomlPath(), 'utf-8')).toBe(approved)

    expect(await removeRealHomeCodexHookForOptOut([CODEX_HASHES])).toBe('removed')

    const after = readHookTrustEntries(tomlPath())
    expect(after.get(computeTrustKey(spelled))).toBeUndefined()
    expect(after.get(computeTrustKey(resolved))).toBeUndefined()
  })

  it("moves user approvals under both keys when Orca's copy leaves a user group", async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    const orca = { type: 'command', command: getCodexManagedHookInstallMaterial().command }
    const userGroup = { hooks: [orca, { type: 'command', command: 'after.sh' }] }
    writeFileSync(hooksPath(), `${JSON.stringify({ hooks: { Stop: [userGroup] } }, null, 2)}\n`)
    const afterAt = (sourcePath: string, handlerIndex: number): CodexTrustEntry => ({
      sourcePath,
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex,
      command: 'after.sh'
    })
    upsertHookTrustEntries(tomlPath(), [
      { ...afterAt(hooksPath(), 1), trustedHash: 'sha256:user-spelled' },
      { ...afterAt(resolvedHooks, 1), trustedHash: 'sha256:user-resolved' }
    ])

    await reconcile()

    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(afterAt(hooksPath(), 0)))?.trustedHash).toBe(
      'sha256:user-spelled'
    )
    expect(trust.get(computeTrustKey(afterAt(resolvedHooks, 0)))?.trustedHash).toBe(
      'sha256:user-resolved'
    )
    expect(trust.get(computeTrustKey(stopEntry(resolvedHooks, 1)))?.trustedHash).toBe(
      CODEX_HASHES.stop
    )
  })

  it('moves a user approval under both keys when the opt-out shifts the hook', async () => {
    const resolvedHooks = linkCodexHomeToDotfiles()
    await reconcile()
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

    expect(await removeRealHomeCodexHookForOptOut([])).toBe('removed')

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

  it('keeps both files when an approval would break config.toml', async () => {
    linkCodexHomeToDotfiles()
    writeFileSync(hooksPath(), `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
    // Why no write: an appended [hooks.state."k"] table would turn this inline
    // form into a file Codex cannot load.
    const original = 'model = "m"\nhooks = { state = {} }\n'
    writeFileSync(tomlPath(), original)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconcile()

    expect(readFileSync(tomlPath(), 'utf-8')).toBe(original)
    expect(JSON.parse(readFileSync(hooksPath(), 'utf-8'))).toEqual({ hooks: {} })
  })
})
