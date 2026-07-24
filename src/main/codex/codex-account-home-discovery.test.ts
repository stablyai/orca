import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pathState, ownershipMock } = vi.hoisted(() => ({
  pathState: { userData: '' },
  ownershipMock: vi.fn()
}))

vi.mock('./codex-home-paths', () => ({
  getOrcaUserDataPath: () => pathState.userData,
  getSystemCodexHomePath: () => join(pathState.userData, 'system-codex')
}))

vi.mock('../codex-accounts/host-codex-managed-home-ownership', () => ({
  assertOwnedHostCodexManagedHomePath: ownershipMock
}))

import { getCodexAccountHomeSessionDirectories } from './codex-account-home-discovery'

let root = ''
let accountsRoot = ''

async function createAccount(accountId: string): Promise<string> {
  const sessionsPath = join(accountsRoot, accountId, 'home', 'sessions')
  await mkdir(sessionsPath, { recursive: true })
  return sessionsPath
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-account-discovery-'))
  pathState.userData = root
  accountsRoot = join(root, 'codex-accounts')
  await mkdir(accountsRoot)
  ownershipMock.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('Codex account-home discovery limits', () => {
  it('preserves sorted valid account homes below every limit', async () => {
    const later = await createAccount('z-account')
    const earlier = await createAccount('a-account')
    await writeFile(join(accountsRoot, 'not-an-account'), 'x')

    expect(getCodexAccountHomeSessionDirectories()).toEqual([earlier, later])
  })

  it('accepts the exact entry limit and fails closed on the next entry', async () => {
    const sessionsPath = await createAccount('account-1')
    await writeFile(join(accountsRoot, 'ignored'), 'x')

    expect(getCodexAccountHomeSessionDirectories({ maxEntries: 2 })).toEqual([sessionsPath])
    await writeFile(join(accountsRoot, 'overflow'), 'x')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getCodexAccountHomeSessionDirectories({ maxEntries: 2 })).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-usage] Account-home discovery exceeded 2 entries; skipping homes'
    )
  })

  it('accepts the exact home limit and fails closed on the next valid home', async () => {
    await createAccount('account-1')
    await createAccount('account-2')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getCodexAccountHomeSessionDirectories({ maxHomes: 2 })).toHaveLength(2)
    expect(getCodexAccountHomeSessionDirectories({ maxHomes: 1 })).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-usage] Account-home discovery exceeded 1 homes; skipping homes'
    )
  })

  it('bounds retained account and session path strings at the exact code-unit limit', async () => {
    const accountId = 'account-1'
    const sessionsPath = await createAccount(accountId)
    const accountHome = join(accountsRoot, accountId, 'home')
    const exactPathCodeUnits = accountId.length + accountHome.length + sessionsPath.length

    expect(getCodexAccountHomeSessionDirectories({ maxPathCodeUnits: exactPathCodeUnits })).toEqual(
      [sessionsPath]
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      getCodexAccountHomeSessionDirectories({ maxPathCodeUnits: exactPathCodeUnits - 1 })
    ).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      `[codex-usage] Account-home discovery exceeded ${exactPathCodeUnits - 1} path code units; skipping homes`
    )
  })
})
