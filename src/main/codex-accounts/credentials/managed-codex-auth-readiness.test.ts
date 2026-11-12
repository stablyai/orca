import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../../shared/managed-account-types'
import {
  readStoredCodexCredentialState,
  waitForManagedCodexAuthReady
} from './managed-codex-auth-readiness'

const roots: string[] = []
const testIdToken = 'e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig'
const testChatGptAuth = {
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'access',
    id_token: testIdToken,
    refresh_token: 'refresh',
    account_id: 'account'
  },
  last_refresh: '2026-07-31T00:00:00Z'
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('waitForManagedCodexAuthReady', () => {
  it('waits for a partial managed ChatGPT credential to become complete', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, {
      tokens: { access_token: 'access', id_token: testIdToken }
    })
    expect(readStoredCodexCredentialState(join(fixture.home, 'auth.json'))).toBe('incomplete')
    let resolved = false
    const readiness = waitForManagedCodexAuthReady(fixture.args)
    void readiness?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    writeAuth(fixture.home, testChatGptAuth)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBe(true)
  })
})

function createFixture(): {
  root: string
  home: string
  args: Parameters<typeof waitForManagedCodexAuthReady>[0]
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-managed-codex-auth-'))
  roots.push(root)
  const home = join(root, 'account', 'home')
  mkdirSync(home, { recursive: true })
  const account = {
    id: 'account-1',
    managedHomePath: home,
    managedHomeRuntime: 'host'
  } as CodexManagedAccount
  return {
    root,
    home,
    args: {
      codexHomePath: home,
      settings: { codexManagedAccounts: [account] } as GlobalSettings,
      target: { runtime: 'host' }
    }
  }
}

function writeAuth(home: string, auth: Record<string, unknown>): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}
