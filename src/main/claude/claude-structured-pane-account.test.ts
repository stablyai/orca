import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { formatClaudeSessionMoveLine } from '../../shared/claude-session-move-line'
import { installClaudePoolLaunchRead } from '../claude-accounts/claude-account-pool-launch'
import {
  getClaudeAuthProxy,
  startClaudeAuthProxy,
  stopClaudeAuthProxy
} from '../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import { claudeAuthProxySlotId } from '../claude-accounts/claude-auth-proxy/claude-auth-proxy-url'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../claude-accounts/claude-profile-router'
import { claudeListedPaneAccounts } from '../claude-accounts/claude-listed-pane-accounts'
import {
  _internals,
  forgetClaudePaneAccount,
  getClaudePaneAccount,
  listClaudePaneAccounts
} from '../claude-accounts/claude-pane-account-registry'
import { collectClaudeMoverSessions } from '../claude-accounts/claude-session-mover-sessions'
import { formatAccountsBlock } from '../../cli/handlers/account-list-format'
import { prepareStructuredClaudeLaunchAccount } from './structured/launch/claude-structured-launch-home'
import { structuredClaudeSessionKey } from './structured/claude-structured-session-key'

const roots: string[] = []

afterEach(async () => {
  installClaudeProfileRouter(undefined)
  installClaudePoolLaunchRead(null)
  _internals.reset()
  await stopClaudeAuthProxy()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function account(id: string, email: string): ClaudeManagedAccount {
  return {
    id,
    email,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function signIn(dir: string, email: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  )
}

async function routerFor(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'claude-structured-pane-'))
  roots.push(root)
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: ids.map((id) => account(id, `${id}@example.test`)),
    activeClaudeManagedAccountId: ids[0] ?? null,
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: [],
    claudeAuthProxy: true
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: join(root, 'data'),
    userHome: join(root, 'personal'),
    env: {},
    runSetup: async () => ({ outcome: 'prepared', warnings: [], surfaces: {} })
  })
  for (const id of ids) {
    const home = router.accountHome(id)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '..', 'profile.json'), '{}')
    if (id === ids[0]) {
      signIn(home, `${id}@example.test`)
    }
  }
  installClaudeProfileRouter(router)
  await startClaudeAuthProxy()
  return { router, settings, root }
}

const SESSION = {
  sessionId: 'chat-session-1',
  providerSessionId: 'prov-1',
  workspaceId: 'workspace-1'
}

describe('structured Claude launch account', () => {
  it('gives the child the proxy slot, records the chat, and reuses that slot on the next turn', async () => {
    const { router } = await routerFor(['a'])
    const first: Record<string, string> = {}
    const home = (await prepareStructuredClaudeLaunchAccount(router, first, '/recorded', SESSION))
      .home
    const slot = claudeAuthProxySlotId(first.ANTHROPIC_BASE_URL ?? '')
    const key = structuredClaudeSessionKey(SESSION.sessionId)
    expect(slot).toBeTruthy()
    expect(first.CLAUDE_CONFIG_DIR).toBe(home)
    expect(getClaudePaneAccount(key)).toMatchObject({
      ptyId: key,
      paneKey: key,
      surface: 'chat',
      accountId: 'a',
      source: 'spawn',
      proxySlot: slot,
      assignedAccountId: 'a',
      providerSessionId: 'prov-1',
      worktreeId: 'workspace-1',
      launchSelectionId: 'a'
    })

    const second: Record<string, string> = {}
    await prepareStructuredClaudeLaunchAccount(router, second, '/recorded', SESSION)
    expect(claudeAuthProxySlotId(second.ANTHROPIC_BASE_URL ?? '')).toBe(slot)
    expect(getClaudeAuthProxy()?.accountIdForSlot(slot ?? '')).toBe('a')
    const live = getClaudeAuthProxy()
      ?.status()
      .slots.map((entry) => entry.slot)
    expect(live).toEqual([slot])
  })

  it('keeps a user base URL and releases the slot it did not apply', async () => {
    const { router } = await routerFor(['a'])
    const env = { ANTHROPIC_BASE_URL: 'https://api.example.test' }
    await prepareStructuredClaudeLaunchAccount(router, env, '/recorded', SESSION)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.test')
    const record = getClaudePaneAccount(structuredClaudeSessionKey(SESSION.sessionId))
    expect(record?.proxySlot).toBeUndefined()
    expect(record?.pinned).toBe(true)
    expect(getClaudeAuthProxy()?.status().slots).toEqual([])
  })

  it('launches on the pool pick, then keeps that account and slot while the selection stays', async () => {
    const { router } = await routerFor(['a', 'b'])
    installClaudePoolLaunchRead(() => ({ accountId: 'b', named: true }))
    const first: Record<string, string> = {}
    const home = (await prepareStructuredClaudeLaunchAccount(router, first, '/recorded', SESSION))
      .home
    expect(home).toBe(router.accountHome('b'))
    const slot = claudeAuthProxySlotId(first.ANTHROPIC_BASE_URL ?? '')
    expect(getClaudePaneAccount(structuredClaudeSessionKey(SESSION.sessionId))).toMatchObject({
      accountId: 'b',
      assignedAccountId: 'b',
      source: 'pool',
      launchSelectionId: 'a',
      proxySlot: slot
    })

    installClaudePoolLaunchRead(() => ({ accountId: 'a', named: false }))
    const second: Record<string, string> = {}
    const again = await prepareStructuredClaudeLaunchAccount(router, second, '/recorded', SESSION)
    expect(again.home).toBe(router.accountHome('b'))
    expect(claudeAuthProxySlotId(second.ANTHROPIC_BASE_URL ?? '')).toBe(slot)
  })

  it('follows a new selection instead of the account the chat was created under', async () => {
    const { router, settings } = await routerFor(['a', 'b'])
    await prepareStructuredClaudeLaunchAccount(router, {}, '/recorded', SESSION)
    settings.activeClaudeManagedAccountId = 'b'
    signIn(router.accountHome('b'), 'b@example.test')
    const env: Record<string, string> = {}
    const home = (await prepareStructuredClaudeLaunchAccount(router, env, '/recorded', SESSION))
      .home
    expect(home).toBe(router.accountHome('b'))
    expect(getClaudePaneAccount(structuredClaudeSessionKey(SESSION.sessionId))?.accountId).toBe('b')
  })

  it('counts a chat in the session line and shows it on a move', () => {
    const key = structuredClaudeSessionKey(SESSION.sessionId)
    const listed = claudeListedPaneAccounts(
      [
        { id: 'a', email: 'a@example.test' },
        { id: 'b', email: 'b@example.test' }
      ],
      [
        {
          ptyId: 'pty-1',
          paneKey: 'tab:leaf',
          accountId: 'a',
          configDir: null,
          launchedAt: 1,
          pinned: false,
          source: 'spawn'
        },
        {
          ptyId: key,
          paneKey: key,
          surface: 'chat',
          accountId: 'a',
          configDir: null,
          launchedAt: 1,
          pinned: false,
          source: 'spawn'
        }
      ]
    )
    expect(listed.assignedSessions).toEqual([
      { accountId: 'a', count: 2, chatCount: 1 },
      { accountId: 'b', count: 0 }
    ])
    expect(
      formatAccountsBlock('Claude', {
        accounts: [
          { id: 'a', email: 'a@example.test' },
          { id: 'b', email: 'b@example.test' }
        ],
        activeAccountId: 'a',
        assignedSessions: listed.assignedSessions
      })
    ).toContain('  a@example.test (active)  sessions: 2 (1 chat)')
    expect(
      formatClaudeSessionMoveLine({
        ptyId: key,
        paneKey: key,
        fromAccountId: 'a',
        toAccountId: 'b',
        window: null,
        percent: null,
        line: null,
        reason: 'moved',
        at: Date.parse('2026-10-30T00:00:00Z'),
        strategy: 'proxy',
        chat: true
      })
    ).toBe(`2026-10-30T00:00:00.000Z  ${key}  a → b  moved  proxy  chat`)
  })

  it('collects a chat from its own workspace and main-agent state when no pty is registered', () => {
    const key = structuredClaudeSessionKey(SESSION.sessionId)
    const [view] = collectClaudeMoverSessions({
      records: [
        {
          ptyId: key,
          paneKey: key,
          surface: 'chat',
          accountId: 'a',
          configDir: '/profiles/a',
          launchedAt: 1,
          pinned: false,
          source: 'spawn',
          providerSessionId: 'prov-1',
          worktreeId: 'workspace-1'
        }
      ],
      statuses: [
        {
          paneKey: key,
          state: 'working',
          mainAgentState: 'done',
          backgroundWork: true,
          turnEndedAt: 9,
          receivedAt: 1,
          observedInCurrentRuntime: true
        }
      ],
      providerSessions: [],
      resolveProviderSession: () => null,
      resolvePaneKey: () => null,
      resolvePtyIdForPaneKey: () => null,
      resolveWorktreeId: () => null,
      accounts: [],
      recordInferred: () => {},
      now: 1
    })
    expect(view).toMatchObject({
      paneState: 'done',
      paneBackgroundWork: true,
      turnEndedAt: 9,
      worktreeId: 'workspace-1',
      providerSession: { key: 'session_id', id: 'prov-1' }
    })
    forgetClaudePaneAccount(key)
    expect(listClaudePaneAccounts()).toEqual([])
  })
})
