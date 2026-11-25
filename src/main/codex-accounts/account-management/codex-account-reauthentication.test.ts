import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexAccountRegistration } from './codex-account-registration'
import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function registration() {
  const home = mkdtempSync(join(tmpdir(), 'orca-chat-sign-in-'))
  roots.push(home)
  let settings: GlobalSettings = {
    ...getDefaultSettings(home),
    codexManagedAccounts: [
      {
        id: 'chat-account',
        email: 'injected@example.invalid',
        managedHomeRuntime: 'host',
        managedHomePath: home,
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }
    ],
    activeCodexManagedAccountId: 'original-selection',
    activeCodexManagedAccountIdsByRuntime: { host: 'original-selection', wsl: {} }
  }
  const dependencies = {
    store: { getSettings: () => settings },
    selection: {
      requireAccount: () => settings.codexManagedAccounts[0],
      saveSettings: (patch: Partial<GlobalSettings>) => {
        settings = { ...settings, ...patch }
      },
      snapshot: () => settings
    },
    managedHomePaths: { ensureForReauthentication: async () => home },
    configMirror: {
      safeSyncIntoManagedHome: vi.fn(async () => {}),
      safeSyncToManagedHomes: async () => {}
    },
    managedHomes: { importAuthFromHome: async () => {} },
    readIdentityFromHome: async () => ({ email: 'injected@example.invalid' }),
    runtimeHome: { clearLastWrittenAuthJson: () => {}, syncForCurrentSelection: () => {} },
    rateLimits: { refreshForCodexAccountChange: async () => {} },
    login: vi.fn(async () => {})
  }
  const instance = new CodexAccountRegistration(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies each dependency called by reauthenticate.
    dependencies as unknown as ConstructorParameters<typeof CodexAccountRegistration>[0]
  )
  return {
    instance,
    dependencies,
    getSettings: () => settings,
    setSelection: (id: string | null) => {
      settings = {
        ...settings,
        activeCodexManagedAccountId: id,
        activeCodexManagedAccountIdsByRuntime: { host: id, wsl: {} }
      }
    }
  }
}
it('preserves the selection made while chat-account sign-in is open', async () => {
  const test = registration()
  test.dependencies.login.mockImplementationOnce(async () => {
    test.setSelection('later-selection')
  })
  await test.instance.reauthenticate('chat-account', { preserveSelection: true })
  expect(test.getSettings().activeCodexManagedAccountId).toBe('later-selection')
  expect(test.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe('later-selection')
})
it('does not activate the chat account when the current selection is empty', async () => {
  const test = registration()
  test.setSelection(null)
  await test.instance.reauthenticate('chat-account', { preserveSelection: true })
  expect(test.getSettings().activeCodexManagedAccountId).toBeNull()
})
it('refuses to launch login when chat authority changes during preparation', async () => {
  const test = registration()
  let current = true
  test.dependencies.configMirror.safeSyncIntoManagedHome.mockImplementationOnce(async () => {
    current = false
  })
  await expect(
    test.instance.reauthenticate('chat-account', {
      preserveSelection: true,
      beforeLogin: async () => {
        if (!current) {
          throw new Error('changed-chat-target')
        }
      }
    })
  ).rejects.toThrow('changed-chat-target')
  expect(test.dependencies.login).not.toHaveBeenCalled()
})
