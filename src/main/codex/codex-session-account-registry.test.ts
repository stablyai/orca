import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { value: '' } }))

vi.mock('./codex-home-paths', () => ({
  getOrcaUserDataPath: () => userDataPath.value
}))

import {
  getCodexSessionAccountId,
  recordCodexSessionAccount,
  resetCodexSessionAccountRegistryForTests
} from './codex-session-account-registry'

describe('codex session account registry', () => {
  beforeEach(() => {
    userDataPath.value = mkdtempSync(join(tmpdir(), 'orca-codex-session-account-'))
    resetCodexSessionAccountRegistryForTests()
  })

  afterEach(() => {
    resetCodexSessionAccountRegistryForTests()
    rmSync(userDataPath.value, { recursive: true, force: true })
  })

  it('persists managed and system account snapshots without identity fields', () => {
    expect(recordCodexSessionAccount('session-managed', 'account-a', 100)).toBe(true)
    expect(recordCodexSessionAccount('session-system', null, 200)).toBe(true)

    resetCodexSessionAccountRegistryForTests()
    expect(getCodexSessionAccountId('session-managed')).toBe('account-a')
    expect(getCodexSessionAccountId('session-system')).toBeNull()
    const persisted = readFileSync(join(userDataPath.value, 'codex-session-accounts.json'), 'utf-8')
    expect(persisted).not.toContain('email')
    expect(persisted).not.toContain('managedHomePath')
  })

  it('keeps the first account snapshot when a session is observed under another account', () => {
    expect(recordCodexSessionAccount('session-1', 'account-a', 100)).toBe(true)
    expect(recordCodexSessionAccount('session-1', 'account-b', 200)).toBe(false)
    expect(getCodexSessionAccountId('session-1')).toBe('account-a')
  })

  it('ignores malformed rows while hydrating persisted data', () => {
    mkdirSync(userDataPath.value, { recursive: true })
    writeFileSync(
      join(userDataPath.value, 'codex-session-accounts.json'),
      JSON.stringify({
        version: 1,
        sessions: {
          good: { accountId: null, observedAt: 10 },
          '': { accountId: 'account-a', observedAt: 10 },
          badAccount: { accountId: '', observedAt: 10 },
          badTime: { accountId: 'account-a', observedAt: 'today' }
        }
      })
    )
    resetCodexSessionAccountRegistryForTests()

    expect(getCodexSessionAccountId('good')).toBeNull()
    expect(getCodexSessionAccountId('badAccount')).toBeUndefined()
    expect(getCodexSessionAccountId('badTime')).toBeUndefined()
  })
})
