import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals as hookServerInternals } from '../agent-hooks/server'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentRunAccountSettings } from '../agent-accounts/agent-run-accounts'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import {
  _internals as registryInternals,
  getCodexPaneAccount,
  recordCodexPaneAccount,
  setCodexPaneKept
} from '../codex/codex-pane-account-registry'
import { paneKeyPtyId, ptyPaneKey, rememberPaneKeyForPty } from '../ipc/pty/pane/key-state'
import {
  getAgentRunAccounts,
  getKeptAgentConversations,
  installAgentRunAccounts,
  noteAgentPaneLaunch
} from '../agent-accounts/agent-run-accounts-installed'
import { startAgentRunAccounts } from './main-process-agent-run-accounts'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

let userDataPath: string
let previousUserDataPath: string | undefined

function codexAccount(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `/data/codex-accounts/${id}/home`,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function claudeAccount(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/data/claude-accounts/${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

beforeEach(() => {
  hookServerInternals.resetCachesForTests()
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-run-accounts-'))
  process.env.ORCA_USER_DATA_PATH = userDataPath
  registryInternals.resetCache()
})

afterEach(() => {
  installAgentRunAccounts(undefined)
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  rmSync(userDataPath, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  registryInternals.resetCache()
})

describe('startAgentRunAccounts', () => {
  it('publishes a terminal agent account onto its status row and reacts to account changes', () => {
    const server = new AgentHookServer()
    let settings: AgentRunAccountSettings = {
      codexManagedAccounts: [codexAccount('acc-a')],
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: undefined
    }
    const settingsListeners: ((updates: Partial<GlobalSettings>) => void)[] = []
    startAgentRunAccounts({
      server,
      getSettings: () => settings,
      onSettingsChanged: (listener) => settingsListeners.push(listener),
      claudeRouter: null,
      keptFilePath: join(userDataPath, 'kept.json')
    })
    expect(getAgentRunAccounts()).toBeDefined()
    rememberPaneKeyForPty('pty-1', PANE)
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: 'acc-a',
      homeRoute: 'account-home'
    })

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt',
      connectionId: null,
      payload: { state: 'working', prompt: 'go', agentType: 'codex' }
    })
    expect(server.getRunAccountRow(PANE)?.runAccount).toEqual({
      provider: 'codex',
      lane: 'host',
      accountId: 'acc-a',
      mode: 'follow'
    })

    settings = { ...settings, codexManagedAccounts: [] }
    for (const listener of settingsListeners) {
      listener({ codexManagedAccounts: [] })
    }
    expect(server.getRunAccountRow(PANE)?.runAccount).toBeUndefined()
  })

  it('releases what was kept on a removed account and leaves other accounts alone', () => {
    const server = new AgentHookServer()
    let settings: AgentRunAccountSettings = {
      codexManagedAccounts: [codexAccount('acc-a'), codexAccount('acc-b')],
      claudeManagedAccounts: [claudeAccount('acc-a')],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: undefined
    }
    const settingsListeners: ((updates: Partial<GlobalSettings>) => void)[] = []
    startAgentRunAccounts({
      server,
      getSettings: () => settings,
      onSettingsChanged: (listener) => settingsListeners.push(listener),
      claudeRouter: null,
      keptFilePath: join(userDataPath, 'kept.json')
    })
    const kept = getKeptAgentConversations()!
    const record = { selectionKey: 'host', homeRoute: 'account-home' } as const
    rememberPaneKeyForPty('pty-1', PANE)
    recordCodexPaneAccount('pty-1', { ...record, accountId: 'acc-a' })
    recordCodexPaneAccount('pty-2', { ...record, accountId: 'acc-b' })
    setCodexPaneKept('pty-1', true)
    setCodexPaneKept('pty-2', true)
    kept.keep('codex', 'c1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    kept.keep('codex', 'c2', { lane: 'host', accountId: 'acc-b', keptAt: 1 })
    kept.keep('claude', 'k1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt',
      connectionId: null,
      payload: { state: 'working', prompt: 'go', agentType: 'codex' }
    })
    expect(server.getRunAccountRow(PANE)?.runAccount).toMatchObject({ mode: 'kept' })

    settings = { ...settings, codexManagedAccounts: [codexAccount('acc-b')] }
    for (const listener of settingsListeners) {
      listener({ codexManagedAccounts: settings.codexManagedAccounts })
    }

    expect(kept.get('codex', 'c1')).toBeNull()
    expect(kept.get('codex', 'c2')).toMatchObject({ accountId: 'acc-b' })
    expect(kept.get('claude', 'k1')).toMatchObject({ accountId: 'acc-a' })
    expect(getCodexPaneAccount('pty-1')).not.toHaveProperty('kept')
    expect(getCodexPaneAccount('pty-2')).toMatchObject({ kept: true })
    expect(server.getRunAccountRow(PANE)?.runAccount).toMatchObject({
      accountId: 'acc-a',
      mode: 'follow'
    })

    settings = { ...settings, claudeManagedAccounts: [] }
    for (const listener of settingsListeners) {
      listener({ claudeManagedAccounts: [] })
    }
    expect(kept.get('claude', 'k1')).toBeNull()
  })

  // The daemon keeps a terminal alive across an Orca restart, and the hydrated row carries the
  // facet the last run persisted, while the idle agent posts nothing that would re-derive it.
  it('keeps a kept Claude agent kept when its terminal reattaches after a restart', async () => {
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    await postHookEvent(
      first,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'go', session_id: 's1' })
    )
    const keptFacet = {
      provider: 'claude',
      lane: 'host',
      accountId: 'acc-a',
      mode: 'kept',
      shellRoute: 'selected'
    } as const
    expect(first.republishRunAccount(PANE, keptFacet)).toBe(true)
    first.flushStatusPersistSync()
    first.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      // Positive control: the restarted host did hydrate the facet.
      expect(server.getRunAccountRow(PANE)?.runAccount).toEqual(keptFacet)
      const settings: AgentRunAccountSettings = {
        codexManagedAccounts: [],
        claudeManagedAccounts: [claudeAccount('acc-a'), claudeAccount('acc-b')],
        activeClaudeManagedAccountId: 'acc-a',
        activeClaudeManagedAccountIdsByRuntime: undefined
      }
      const settingsListeners: ((updates: Partial<GlobalSettings>) => void)[] = []
      startAgentRunAccounts({
        server,
        getSettings: () => settings,
        onSettingsChanged: (listener) => settingsListeners.push(listener),
        claudeRouter: null,
        keptFilePath: join(userDataPath, 'kept.json')
      })
      getKeptAgentConversations()!.keep('claude', 's1', {
        lane: 'host',
        accountId: 'acc-a',
        keptAt: 1
      })

      noteAgentPaneLaunch({ paneKey: PANE, lane: 'host', fresh: false })
      expect(server.getRunAccountRow(PANE)?.runAccount).toEqual(keptFacet)

      // Adding, removing or re-authenticating an account refreshes every pane.
      for (const listener of settingsListeners) {
        listener({ claudeManagedAccounts: settings.claudeManagedAccounts })
      }
      expect(server.getRunAccountRow(PANE)?.runAccount).toEqual(keptFacet)

      await postHookEvent(server, buildBody({ hook_event_name: 'Stop', session_id: 's1' }))
      expect(server.getRunAccountRow(PANE)?.runAccount).toEqual(keptFacet)
    } finally {
      server.stop()
    }
  })
})
