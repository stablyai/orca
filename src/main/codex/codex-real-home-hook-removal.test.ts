import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
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
  readHookTrustEntries,
  upsertHookTrustEntries,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './config-toml-trust'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { removeRealHomeCodexHookForOptOut } from './codex-real-home-hook-install'
import { CodexHookService, getCodexManagedHookInstallMaterial } from './hook-service'
import { memoizeCodexHookAnswer } from './codex-hook-trust-memo'
import {
  readCodexTrustGrantLedgerHome,
  writeCodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

// Why this file: the opt-out is the one path that removes Orca's entry from
// the user's real ~/.codex, and it must leave the user's own hooks approved.

let root: string
let home: string
let userDataDir: string

const hooksJsonPath = (): string => join(home, '.codex', 'hooks.json')
const configTomlPath = (): string => join(home, '.codex', 'config.toml')

function readHooks(): { hooks?: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(hooksJsonPath(), 'utf-8'))
}

function orcaHandler(): { type: string; command: string; timeout: number } {
  return { type: 'command', command: getCodexManagedHookInstallMaterial().command, timeout: 10 }
}

function orcaStopAt(sourcePath: string, groupIndex = 0): CodexTrustEntry {
  return {
    sourcePath,
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: orcaHandler().command
  }
}

beforeEach(() => {
  // Why realpath: a symlinked temp dir (macOS /var) would give ~/.codex a second key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-real-home-removal-')))
  home = join(root, 'home')
  userDataDir = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userDataDir)
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  vi.stubEnv('CODEX_HOME', '')
  homedirMock.mockReturnValue(home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('removeRealHomeCodexHookForOptOut', () => {
  it('creates nothing when the user has no ~/.codex', async () => {
    expect(await removeRealHomeCodexHookForOptOut([])).toBe('removed')
    expect(existsSync(join(home, '.codex'))).toBe(false)
  })

  it("keeps a malformed hooks.json's bytes, Orca's trust and its ledger", async () => {
    mkdirSync(join(home, '.codex'))
    const entry: CodexTrustEntry = { ...orcaStopAt(hooksJsonPath()), timeoutSec: 10 }
    writeFileSync(configTomlPath(), upsertHookTrustEntriesInContent('', [entry]), 'utf-8')
    writeCodexTrustGrantLedgerHome(join(home, '.codex'), { binary: null, entries: {} })
    writeFileSync(hooksJsonPath(), '{ not json', 'utf-8')

    expect(await removeRealHomeCodexHookForOptOut([])).toBe('unavailable')

    // The entry may still be there, so its trust and the ownership proof must be too.
    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe('{ not json')
    expect(readHookTrustEntries(configTomlPath()).has(computeTrustKey(entry))).toBe(true)
    expect(readCodexTrustGrantLedgerHome(join(home, '.codex'))).not.toBeNull()
  })

  it('keeps everything when hooks.json cannot be read', async () => {
    mkdirSync(hooksJsonPath(), { recursive: true })

    expect(await removeRealHomeCodexHookForOptOut([])).toBe('unavailable')
  })

  it('removes only hash-proven Orca trust from a mixed hook group', async () => {
    mkdirSync(join(home, '.codex'))
    const userCommand = 'my-user-hook.sh'
    writeFileSync(
      hooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: userCommand }, orcaHandler()] }] } }, null, 2)}\n`
    )
    const entries: CodexTrustEntry[] = [
      {
        sourcePath: hooksJsonPath(),
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: userCommand
      },
      {
        sourcePath: hooksJsonPath(),
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 1,
        command: orcaHandler().command,
        timeoutSec: 10
      }
    ]
    writeFileSync(configTomlPath(), upsertHookTrustEntriesInContent('', entries), 'utf-8')

    expect(await removeRealHomeCodexHookForOptOut([])).toBe('removed')

    expect(readHooks().hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: userCommand }] }
    ])
    const trust = readHookTrustEntries(configTomlPath())
    expect(trust.has(computeTrustKey(entries[0]!))).toBe(true)
    expect(trust.has(computeTrustKey(entries[1]!))).toBe(false)
  })

  it("moves the approval of a user hook that sat after Orca's, so it stays approved", async () => {
    mkdirSync(join(home, '.codex'))
    const before = { type: 'command', command: 'before.sh' }
    const after = { type: 'command', command: 'after.sh' }
    writeFileSync(
      hooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [before] }, { hooks: [orcaHandler()] }, { hooks: [after] }] } }, null, 2)}\n`
    )
    const afterAt = (groupIndex: number): CodexTrustEntry => ({
      sourcePath: hooksJsonPath(),
      eventLabel: 'stop',
      groupIndex,
      handlerIndex: 0,
      command: 'after.sh'
    })
    upsertHookTrustEntries(configTomlPath(), [
      { ...afterAt(2), trustedHash: 'sha256:user-approved' }
    ])

    expect(await removeRealHomeCodexHookForOptOut([])).toBe('removed')

    expect(readHooks().hooks?.Stop).toEqual([{ hooks: [before] }, { hooks: [after] }])
    const trust = readHookTrustEntries(configTomlPath())
    expect(trust.get(computeTrustKey(afterAt(1)))?.trustedHash).toBe('sha256:user-approved')
    expect(trust.get(computeTrustKey(afterAt(2)))).toBeUndefined()
  })

  it("removes Orca's approval holding Codex's own hash, which Orca cannot compute", async () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(
      hooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [orcaHandler()] }] } }, null, 2)}\n`
    )
    const orcaAt = orcaStopAt(hooksJsonPath())
    upsertHookTrustEntries(configTomlPath(), [{ ...orcaAt, trustedHash: 'sha256:codex-stop' }])

    expect(await removeRealHomeCodexHookForOptOut([{ stop: 'sha256:codex-stop' }])).toBe('removed')

    expect(readHookTrustEntries(configTomlPath()).has(computeTrustKey(orcaAt))).toBe(false)
  })

  it("removes approvals left after the entry is gone, by Codex's hash", async () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(hooksJsonPath(), `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
    const orcaAt = orcaStopAt(hooksJsonPath())
    upsertHookTrustEntries(configTomlPath(), [{ ...orcaAt, trustedHash: 'sha256:codex-stop' }])

    expect(await removeRealHomeCodexHookForOptOut([{ stop: 'sha256:codex-stop' }])).toBe('removed')

    expect(readHookTrustEntries(configTomlPath()).has(computeTrustKey(orcaAt))).toBe(false)
  })
})

describe('turning hooks off', () => {
  it("removes both key spellings, and a hash from Codex's older saved version", async () => {
    const target = join(home, 'dotfiles-codex')
    mkdirSync(target)
    symlinkSync(target, join(home, '.codex'), process.platform === 'win32' ? 'junction' : 'dir')
    const resolvedHooksPath = join(target, 'hooks.json')
    writeFileSync(
      hooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [orcaHandler()] }] } }, null, 2)}\n`
    )
    const command = getCodexManagedHookInstallMaterial().command
    // Why two versions: the approval came from a Codex since updated, whose answer the cache still holds.
    memoizeCodexHookAnswer(join(root, 'codex'), 'old', command, {
      kind: 'hashes',
      codexVersion: 'codex-cli 0.150.0',
      hashes: { stop: 'sha256:codex-old-stop' }
    })
    memoizeCodexHookAnswer(join(root, 'codex'), 'new', command, {
      kind: 'hashes',
      codexVersion: 'codex-cli 0.160.1',
      hashes: { stop: 'sha256:codex-new-stop' }
    })
    upsertHookTrustEntries(configTomlPath(), [
      { ...orcaStopAt(hooksJsonPath()), trustedHash: 'sha256:codex-old-stop' },
      { ...orcaStopAt(resolvedHooksPath), trustedHash: 'sha256:codex-old-stop' }
    ])

    await new CodexHookService().remove()

    expect(readHooks().hooks?.Stop).toBeUndefined()
    const trust = readHookTrustEntries(configTomlPath())
    expect(trust.has(computeTrustKey(orcaStopAt(hooksJsonPath())))).toBe(false)
    expect(trust.has(computeTrustKey(orcaStopAt(resolvedHooksPath)))).toBe(false)
  })
})
