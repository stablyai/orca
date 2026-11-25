import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/agent-accounts/managed-account-types'
import { ClaudeAccountService } from './service'

// Listing accounts must never reach the real Keychain.
vi.mock('../macos-keychain/generic-password', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readKeychainPassword: async () => null
}))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const account: ClaudeManagedAccount = {
  id: 'a',
  email: 'a@example.test',
  managedAuthPath: '',
  managedAuthRuntime: 'host',
  wslDistro: null,
  authMethod: 'subscription-oauth',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

// Idle chats move to the selected account only on a `committed()` that still holds when they stop,
// so a check told about a selection that new launches don't follow could stop chats wrongly.
it('tells chat checks only when a selection settles, and none while it is uncertain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-selection-settle-'))
  roots.push(root)
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [account],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
  }
  const runtimeAuth = {
    router: {
      accountHome: (id: string) => join(root, id, 'home'),
      userConfigDir: () => join(root, 'personal'),
      systemDefaultHome: () => join(root, 'personal'),
      copiedLoginIntoSystemDefault: () => false,
      coveredBySystemDefault: () => false
    },
    syncForCurrentSelection: vi.fn(async () => {}),
    publishAll: vi.fn(async () => {}),
    prepareAccountFolder: vi.fn(),
    removeAccountFolder: vi.fn(),
    getRuntimeConfigDir: () => '/unused'
  }
  const service = new ClaudeAccountService(
    {
      getSettings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch }
      }
    },
    { evictInactiveClaudeCache: vi.fn(), refreshForClaudeAccountChange: vi.fn(async () => {}) },
    runtimeAuth
  )
  const told: (() => boolean)[] = []
  service.onSelectionApplied((committed) => told.push(committed))

  await service.selectAccount(null)
  expect(told).toHaveLength(1)
  expect(told[0]!()).toBe(true)

  // Refused before anything was saved: nothing moved, so no one is told and the check stands.
  await expect(service.selectAccount('missing')).rejects.toThrow()
  expect(told).toHaveLength(1)
  expect(told[0]!()).toBe(true)

  // Publishing fails and the earlier selection is republished: checks run again against it.
  runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
  await expect(service.selectAccount(null)).rejects.toThrow('publish failed')
  expect(told).toHaveLength(2)
  expect(told[0]!()).toBe(false)
  expect(told[1]!()).toBe(true)

  // The restore fails too: no check may act until a later change settles, which tells them again.
  runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
  runtimeAuth.publishAll.mockRejectedValueOnce(new Error('restore failed'))
  await expect(service.selectAccount(null)).rejects.toThrow('publish failed')
  expect(told).toHaveLength(2)
  expect(told[1]!()).toBe(false)
  await expect(service.selectAccount('missing')).rejects.toThrow()
  expect(told).toHaveLength(2)
  await service.selectAccount(null)
  expect(told).toHaveLength(3)
  expect(told[2]!()).toBe(true)
})
