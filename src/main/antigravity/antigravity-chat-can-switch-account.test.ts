import { expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { antigravityHostAccountHome } from './antigravity-host-acp'
import { antigravityAgyOrcaAccountHome } from './antigravity-agy-orca-home'
import { AntigravityAccountService } from './native-account-service'
import type { AntigravityAccountVault } from './native-account-store'
import { antigravityChatCanSwitchAccount } from './antigravity-chat-can-switch-account'

type Chat = Pick<AgentSessionRecord, 'provider' | 'location' | 'accountHome'>

const saved = (id: string) => ({
  id,
  email: `${id}@example.com`,
  subject: id,
  authMethod: 'consumer',
  credentials: '{}',
  createdAt: 1,
  updatedAt: 1
})

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    provider: 'antigravity',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'w',
      workspaceKind: 'git-worktree'
    },
    accountHome: antigravityHostAccountHome('/home/fixture'),
    ...overrides
  }
}

// The vault read the host uses, over a credential backend whose every read throws: deciding must
// never read agy's login.
function sources(vault: AntigravityAccountVault, savedChatAuth: unknown = undefined) {
  const backend = {
    read: vi.fn(async () => {
      throw new Error("read agy's login")
    }),
    write: vi.fn(async () => {
      throw new Error("wrote agy's login")
    }),
    readWithoutPrompt: vi.fn(async () => {
      throw new Error("read agy's login")
    })
  }
  const store = { read: async () => structuredClone(vault), write: vi.fn(async () => {}) }
  const service = new AntigravityAccountService(store, backend)
  let signIn = false
  return {
    backend,
    setSignIn: (running: boolean) => {
      signIn = running
    },
    sources: {
      savedChatAuth,
      signInRunning: () => signIn,
      savedAccounts: () => service.readSelection()
    }
  }
}

const twoAccounts = { accounts: [saved('a'), saved('b')], selectedAccountId: 'a' }

it('offers a switch only for a host chat on agy’s Google login with another saved account', async () => {
  const host = sources(twoAccounts)
  expect(await antigravityChatCanSwitchAccount(chat(), host.sources)).toBe(true)

  expect(await antigravityChatCanSwitchAccount(chat({ provider: 'claude' }), host.sources)).toBe(
    false
  )
  const wsl = chat({ location: { ...chat().location, wslDistro: 'Ubuntu' } })
  expect(await antigravityChatCanSwitchAccount(wsl, host.sources)).toBe(false)
  const elsewhere = chat({ accountHome: { variable: 'GEMINI_HOME', path: '/tmp/other' } })
  expect(await antigravityChatCanSwitchAccount(elsewhere, host.sources)).toBe(false)

  host.setSignIn(true)
  expect(await antigravityChatCanSwitchAccount(chat(), host.sources)).toBe(false)

  const one = sources({ accounts: [saved('a')], selectedAccountId: 'a' })
  expect(await antigravityChatCanSwitchAccount(chat(), one.sources)).toBe(false)
  // Two saved, neither selected: either one is another account.
  const unselected = sources({ ...twoAccounts, selectedAccountId: null })
  expect(await antigravityChatCanSwitchAccount(chat(), unselected.sources)).toBe(true)

  for (const { backend } of [host, one, unselected]) {
    expect(backend.read).not.toHaveBeenCalled()
    expect(backend.readWithoutPrompt).not.toHaveBeenCalled()
  }
})

it('offers a switch for an Orca-home chat only while its saved method uses agy’s Google login', async () => {
  const orcaHome = chat({ accountHome: antigravityAgyOrcaAccountHome('/data/orca') })
  const method = async (savedChatAuth: unknown) =>
    antigravityChatCanSwitchAccount(orcaHome, sources(twoAccounts, savedChatAuth).sources)

  expect(
    await method({ method: 'oauth-business', gcpProject: 'p', gcpLocation: 'us-central1' })
  ).toBe(true)
  expect(await method({ method: 'oauth-personal' })).toBe(true)
  expect(await method({ method: 'gemini-api-key' })).toBe(false)
  expect(await method({ method: 'agent-platform' })).toBe(false)
  expect(await method({ method: 'not-a-method' })).toBe(false)
})
