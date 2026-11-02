import { afterEach, describe, expect, it } from 'vitest'
import { claudeListedPaneAccounts } from '../../../claude-accounts/claude-listed-pane-accounts'
import {
  _internals,
  getClaudePaneAccount,
  listClaudePaneAccounts,
  recordClaudePaneAccount
} from '../../../claude-accounts/claude-pane-account-registry'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import { getClaudeWslSelectionKey } from '../../../claude-accounts/runtime-selection'
import {
  claudeAccountIdFromProvenance,
  recordClaudePaneAccountForSpawn
} from './claude-pane-account'

const HOST = { runtime: 'host' as const }
const settings = {
  activeClaudeManagedAccountId: 'a',
  activeClaudeManagedAccountIdsByRuntime: undefined
}

function auth(
  provenance: string,
  configDir = '/data/claude-profiles/b/home'
): ClaudeRuntimeAuthPreparation {
  return { configDir, envPatch: { CLAUDE_CONFIG_DIR: configDir }, provenance }
}

function spawn(overrides: Partial<Parameters<typeof recordClaudePaneAccountForSpawn>[0]> = {}) {
  recordClaudePaneAccountForSpawn({
    ptyId: 'pty-1',
    paneKey: 'tab-1:leaf-1',
    isClaudeLaunch: true,
    isReattach: false,
    claudeAuth: auth('profile:b'),
    settings,
    target: HOST,
    now: 5_000,
    ...overrides
  })
}

describe('recordClaudePaneAccountForSpawn', () => {
  afterEach(() => {
    _internals.reset()
  })

  it('maps provenance to the account', () => {
    expect(claudeAccountIdFromProvenance('profile:b', settings, HOST)).toBe('b')
    expect(claudeAccountIdFromProvenance('profile:b:wsl:Ubuntu', settings, HOST)).toBe('b')
    // System default runs the selected account when it covers it.
    expect(claudeAccountIdFromProvenance('system', settings, HOST)).toBe('a')
    expect(
      claudeAccountIdFromProvenance('system', { activeClaudeManagedAccountId: null }, HOST)
    ).toBeNull()
    expect(claudeAccountIdFromProvenance('profile:unavailable', settings, HOST)).toBeNull()
    // Upstream builds `profile:${profile?.accountId}`; a missing id names no account.
    expect(claudeAccountIdFromProvenance('profile:', settings, HOST)).toBeNull()
    expect(claudeAccountIdFromProvenance('profile:undefined', settings, HOST)).toBeNull()
    expect(claudeAccountIdFromProvenance('profile:null', settings, HOST)).toBeNull()
    // WSL System default runs the account selected for that distro.
    const wslSettings = {
      activeClaudeManagedAccountId: 'a',
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'a',
        wsl: { [getClaudeWslSelectionKey('Ubuntu')]: 'w' }
      }
    }
    expect(
      claudeAccountIdFromProvenance('wsl:Ubuntu:system', wslSettings, {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ).toBe('w')
    // The target decides the runtime: against a host target the host selection answers.
    expect(claudeAccountIdFromProvenance('wsl:Ubuntu:system', wslSettings, HOST)).toBe('a')
  })

  it('records a routed Claude launch as unpinned', () => {
    spawn()
    expect(getClaudePaneAccount('pty-1')).toEqual({
      ptyId: 'pty-1',
      paneKey: 'tab-1:leaf-1',
      accountId: 'b',
      configDir: '/data/claude-profiles/b/home',
      launchedAt: 5_000,
      pinned: false,
      source: 'spawn'
    })
  })

  it('counts a reattach into an empty registry without keeping the new proxy slot', () => {
    spawn({
      isReattach: true,
      claudeAuth: {
        ...auth('profile:b'),
        envPatch: {
          CLAUDE_CONFIG_DIR: '/data/claude-profiles/b/home',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/p/fresh/'
        }
      }
    })
    expect(getClaudePaneAccount('pty-1')).toMatchObject({ accountId: 'b', source: 'spawn' })
    expect(getClaudePaneAccount('pty-1')?.proxySlot).toBeUndefined()
    expect(getClaudePaneAccount('pty-1')?.assignedAccountId).toBeUndefined()
    expect(
      claudeListedPaneAccounts([{ id: 'b', email: 'b@example.test' }], listClaudePaneAccounts())
        .assignedSessions
    ).toEqual([{ accountId: 'b', count: 1 }])
  })

  it('leaves a reattached PTY alone and forgets a reused id that runs something else', () => {
    spawn()
    spawn({ isReattach: true, claudeAuth: null, isClaudeLaunch: false })
    expect(getClaudePaneAccount('pty-1')?.accountId).toBe('b')
    spawn({ isClaudeLaunch: false, claudeAuth: null })
    expect(getClaudePaneAccount('pty-1')).toBeNull()
  })

  it('records a pooled launch as a pool assignment', () => {
    spawn({ claudeAuth: { ...auth('profile:b'), pooled: true } })
    expect(getClaudePaneAccount('pty-1')).toMatchObject({
      accountId: 'b',
      source: 'pool',
      assignedAccountId: 'b',
      pinned: false
    })
  })

  it('records the proxy slot and bills the spawn account until a move', () => {
    spawn({
      claudeAuth: {
        ...auth('profile:b'),
        envPatch: {
          CLAUDE_CONFIG_DIR: '/data/claude-profiles/b/home',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/p/abc123/'
        }
      }
    })
    expect(getClaudePaneAccount('pty-1')).toMatchObject({
      accountId: 'b',
      proxySlot: 'abc123',
      assignedAccountId: 'b'
    })
  })

  it('stores an empty configDir as unknown', () => {
    spawn({ claudeAuth: auth('profile:b', '') })
    expect(getClaudePaneAccount('pty-1')).toMatchObject({ accountId: 'b', configDir: null })
  })

  it('forgets a launch whose account cannot be named', () => {
    recordClaudePaneAccount({
      ptyId: 'pty-1',
      paneKey: null,
      accountId: 'old',
      configDir: null,
      launchedAt: 1,
      pinned: false,
      source: 'spawn'
    })
    spawn({ claudeAuth: auth('profile:unavailable', '') })
    expect(getClaudePaneAccount('pty-1')).toBeNull()
  })
})
