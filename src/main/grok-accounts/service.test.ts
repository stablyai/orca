import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { importGrokAccount, listGrokAccounts, selectGrokAccount } from './service'
import { getOwnedGrokAccountHome, getSelectedGrokAccountHome, readGrokAccountIndex } from './paths'
import { pinGrokLaunchAccount, pinGrokTerminalCreateOptions } from './launch'
import { readGrokAuthSession } from '../rate-limits/grok-auth'

vi.mock('../rate-limits/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn(async ({ authReadResult }) => ({
    provider: 'grok',
    status: authReadResult.status,
    session: null,
    weekly: { usedPercent: authReadResult.session?.userId === 'alice' ? 16 : 12 },
    updatedAt: 1,
    error: null
  }))
}))

let root: string
function source(id: string): string {
  const path = join(root, `source-${id}`)
  mkdirSync(path)
  writeFileSync(
    join(path, 'auth.json'),
    JSON.stringify({
      'https://auth.x.ai::client': {
        key: `secret-${id}`,
        user_id: id,
        email: `${id}@example.com`,
        expires_at: '2099-01-01T00:00:00Z'
      }
    })
  )
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-grok-account-test-'))
  installFakeAppEnvironment({ getPath: () => root })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('managed Grok accounts', () => {
  it('imports two identities with separate usage without changing the default login', async () => {
    await importGrokAccount(source('alice'))
    const state = await importGrokAccount(source('bob'))
    expect(state.accounts.map((a) => a.email)).toEqual(['alice@example.com', 'bob@example.com'])
    expect(state.activeAccountId).toBeNull()
    expect(getSelectedGrokAccountHome()).toBeNull()
    expect(state.accounts.map((a) => state.usage[a.id].weekly?.usedPercent)).toEqual([16, 12])
    expect(JSON.stringify(state)).not.toContain('secret-')
    expect(readFileSync(join(root, 'grok-accounts', 'accounts.json'), 'utf8')).not.toContain(
      'secret-'
    )
  })

  it('persists selection, pins new sessions, and keeps a resumed session on its original account', async () => {
    await importGrokAccount(source('alice'))
    const state = await importGrokAccount(source('bob'))
    const [alice, bob] = state.accounts
    const selected = vi.fn()
    await selectGrokAccount(alice.id, selected)
    expect(selected).toHaveBeenCalledOnce()
    const first = pinGrokLaunchAccount(
      {},
      { agentCommand: 'grok', agentArgs: '', agentEnv: {} },
      'grok',
      true
    )
    await selectGrokAccount(bob.id)
    const second = pinGrokLaunchAccount(
      {},
      { agentCommand: 'grok', agentArgs: '', agentEnv: {} },
      'grok',
      true
    )
    expect(first.env?.GROK_HOME).toBe(getOwnedGrokAccountHome(alice.id))
    expect(second.env?.GROK_HOME).toBe(getOwnedGrokAccountHome(bob.id))
    expect(first.env?.GROK_LEADER_SOCKET).toBe(
      join(getOwnedGrokAccountHome(alice.id), 'leader.sock')
    )
    expect(second.env?.GROK_LEADER_SOCKET).not.toBe(first.env?.GROK_LEADER_SOCKET)
    expect(readGrokAccountIndex().activeAccountId).toBe(bob.id)
    expect(readGrokAuthSession()).toMatchObject({ status: 'ok', session: { userId: 'bob' } })
    const resumed = pinGrokLaunchAccount({}, first.launchConfig, 'grok', true)
    expect(resumed.env?.GROK_HOME).toBe(first.env?.GROK_HOME)
    expect(resumed.env?.GROK_LEADER_SOCKET).toBe(first.env?.GROK_LEADER_SOCKET)
  })

  it('rejects unknown, duplicate and mismatched identities without changing selection', async () => {
    const path = source('alice')
    const state = await importGrokAccount(path)
    const id = state.accounts[0].id
    await expect(importGrokAccount(path)).rejects.toThrow('already saved')
    await expect(selectGrokAccount('unknown')).rejects.toThrow('not found')
    await expect(selectGrokAccount('../outside')).rejects.toThrow('not found')
    const home = getOwnedGrokAccountHome(id)
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({ 'https://auth.x.ai::client': { key: 'wrong', user_id: 'bob' } })
    )
    await expect(selectGrokAccount(id)).rejects.toThrow('no longer matches')
    expect(readGrokAccountIndex().activeAccountId).toBeNull()
  })

  it('keeps the other account visible when one folder is damaged', async () => {
    await importGrokAccount(source('alice'))
    const state = await importGrokAccount(source('bob'))
    rmSync(join(getOwnedGrokAccountHome(state.accounts[0].id), '.orca-grok-account'))
    const listed = await listGrokAccounts()
    expect(listed.usage[state.accounts[0].id].status).toBe('error')
    expect(listed.usage[state.accounts[1].id].weekly?.usedPercent).toBe(12)
  })

  it('does not inject host accounts into WSL, SSH or a different agent', () => {
    const launchConfig = { agentCommand: 'grok', agentArgs: '', agentEnv: {} }
    expect(pinGrokLaunchAccount({}, launchConfig, 'grok', false).env).toEqual({})
    expect(pinGrokLaunchAccount({}, undefined, 'codex', true).env).toEqual({})
    expect(
      pinGrokTerminalCreateOptions(
        { env: {}, launchConfig, launchAgent: 'grok' },
        { path: 'C:/workspace' },
        'wsl.exe'
      ).env
    ).toEqual({})
  })
})
