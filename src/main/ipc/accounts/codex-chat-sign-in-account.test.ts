import { beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import type { CodexManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import { codexChatSignInAccount } from './codex-chat-sign-in-account'

const { host } = vi.hoisted(() => ({
  host: { deps: { store: { getRecord: vi.fn() }, launchAccountHome: vi.fn() } }
}))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))
const local = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder',
  workspaceKind: 'folder'
}
function account(id: string, managedHomePath: string): CodexManagedAccount {
  return {
    id,
    email: 'injected@example.invalid',
    managedHomeRuntime: 'host',
    managedHomePath,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}
const settings = (): GlobalSettings => ({
  ...getDefaultSettings('/injected'),
  codexManagedAccounts: [
    account('chat-account', '/accounts/chat'),
    account('other-account', '/accounts/other')
  ],
  activeCodexManagedAccountId: 'other-account'
})
beforeEach(() => {
  host.deps.store.getRecord.mockReturnValue({
    sessionId: 'chat',
    provider: 'codex',
    location: local
  })
  host.deps.launchAccountHome.mockResolvedValue({ variable: 'CODEX_HOME', path: '/accounts/chat' })
})
it('signs in the chat launch account even when the status bar has another account selected', async () => {
  expect(await codexChatSignInAccount('chat', settings)).toBe('chat-account')
})
it('does not send a remote or WSL chat to local account sign-in', async () => {
  for (const location of [
    { ...local, executionHostId: 'remote:server' },
    { ...local, wslDistro: 'Ubuntu' }
  ]) {
    host.deps.store.getRecord.mockReturnValue({ provider: 'codex', location })
    expect(await codexChatSignInAccount('chat', settings)).toBeNull()
  }
})
it('refuses sign-in if the execution host changes during launch-account resolution', async () => {
  host.deps.launchAccountHome.mockImplementationOnce(async () => {
    host.deps.store.getRecord.mockReturnValue({
      provider: 'codex',
      location: { ...local, executionHostId: 'remote:server' }
    })
    return { variable: 'CODEX_HOME', path: '/accounts/chat' }
  })
  expect(await codexChatSignInAccount('chat', settings)).toBeNull()
})
it('does not offer a removed or unrecognized managed home', async () => {
  host.deps.launchAccountHome.mockResolvedValueOnce({
    variable: 'CODEX_HOME',
    path: '/accounts/removed'
  })
  expect(await codexChatSignInAccount('chat', settings)).toBeNull()
})

it('refuses login into a home that no longer matches the chat launch home', async () => {
  expect(await codexChatSignInAccount('chat', settings, '/accounts/previous-home')).toBeNull()
})
