import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { removeRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import { getCodexManagedHookInstallMaterial } from './hook-service'
import {
  readCodexTrustGrantLedgerHome,
  writeCodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

// Why this file: app start runs the removal while hooks are on, so every
// Orca start reaches the user's real ~/.codex through it.

let fakeHomeDir: string
let userDataDir: string

const hooksJsonPath = (): string => join(fakeHomeDir, '.codex', 'hooks.json')
const configTomlPath = (): string => join(fakeHomeDir, '.codex', 'config.toml')

function readHooks(): { hooks?: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(hooksJsonPath(), 'utf-8'))
}

function orcaHandler(): { type: string; command: string; timeout: number } {
  return { type: 'command', command: getCodexManagedHookInstallMaterial().command, timeout: 10 }
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-removal-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-removal-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(fakeHomeDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('removeRealHomeCodexHookEntries', () => {
  it('creates nothing when the user has no ~/.codex', async () => {
    expect(await removeRealHomeCodexHookEntries()).toBe('removed')
    expect(existsSync(join(fakeHomeDir, '.codex'))).toBe(false)
  })

  it("keeps a malformed hooks.json's bytes, Orca's trust and its ledger", async () => {
    mkdirSync(join(fakeHomeDir, '.codex'))
    const entry: CodexTrustEntry = {
      sourcePath: hooksJsonPath(),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: orcaHandler().command,
      timeoutSec: 10
    }
    writeFileSync(configTomlPath(), upsertHookTrustEntriesInContent('', [entry]), 'utf-8')
    writeCodexTrustGrantLedgerHome(join(fakeHomeDir, '.codex'), { binary: null, entries: {} })
    writeFileSync(hooksJsonPath(), '{ not json', 'utf-8')

    expect(await removeRealHomeCodexHookEntries()).toBe('unavailable')

    // The entry may still be there, so its trust and the ownership proof must be too.
    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe('{ not json')
    expect(readHookTrustEntries(configTomlPath()).has(computeTrustKey(entry))).toBe(true)
    expect(readCodexTrustGrantLedgerHome(join(fakeHomeDir, '.codex'))).not.toBeNull()
  })

  it('keeps everything when hooks.json cannot be read', async () => {
    mkdirSync(hooksJsonPath(), { recursive: true })

    expect(await removeRealHomeCodexHookEntries()).toBe('unavailable')
  })

  it('removes only hash-proven Orca trust from a mixed hook group', async () => {
    mkdirSync(join(fakeHomeDir, '.codex'))
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

    expect(await removeRealHomeCodexHookEntries()).toBe('removed')

    expect(readHooks().hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: userCommand }] }
    ])
    const trust = readHookTrustEntries(configTomlPath())
    expect(trust.has(computeTrustKey(entries[0]!))).toBe(true)
    expect(trust.has(computeTrustKey(entries[1]!))).toBe(false)
  })

  it("moves the approval of a user hook that sat after Orca's, so it stays approved", async () => {
    mkdirSync(join(fakeHomeDir, '.codex'))
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

    expect(await removeRealHomeCodexHookEntries()).toBe('removed')

    expect(readHooks().hooks?.Stop).toEqual([{ hooks: [before] }, { hooks: [after] }])
    const trust = readHookTrustEntries(configTomlPath())
    expect(trust.get(computeTrustKey(afterAt(1)))?.trustedHash).toBe('sha256:user-approved')
    expect(trust.get(computeTrustKey(afterAt(2)))).toBeUndefined()
  })
})
