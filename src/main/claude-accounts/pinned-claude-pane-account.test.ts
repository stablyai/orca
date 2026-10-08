import { afterEach, describe, expect, it } from 'vitest'
import {
  _internals,
  markPinnedClaudePtySpawned,
  seedPinnedClaudePtysFromPersistence
} from './claude-pinned-pty-registry'
import { pinnedClaudeAccountIdForPane, withPinnedClaudeAccount } from './pinned-claude-pane-account'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function lookup(options: { livePtyId?: string; persistedPtyId?: string }) {
  return {
    getLivePtyIdForPaneKey: (paneKey: string) =>
      paneKey === PANE_KEY ? options.livePtyId : undefined,
    getPersistedTerminalLayouts: () =>
      options.persistedPtyId
        ? { 'tab-1': { ptyIdsByLeafId: { [LEAF]: options.persistedPtyId } } }
        : {}
  }
}

describe('pinnedClaudeAccountIdForPane', () => {
  afterEach(() => {
    _internals.reset()
  })

  it('stamps the account of the live PTY bound to the pane', () => {
    markPinnedClaudePtySpawned('pty-1', 'acct-b')
    expect(
      withPinnedClaudeAccount(
        { paneKey: PANE_KEY, connectionId: null },
        lookup({ livePtyId: 'pty-1' })
      )
    ).toEqual({
      paneKey: PANE_KEY,
      connectionId: null,
      claudeAccountId: 'acct-b'
    })
  })

  it('resolves a restored pane through its persisted PTY before it reattaches', () => {
    // Restart: the registry is seeded from claude-pinned-pane-accounts.json and nothing is bound yet.
    seedPinnedClaudePtysFromPersistence({ 'wt@@pty-1': 'acct-b' })
    expect(
      pinnedClaudeAccountIdForPane(
        { paneKey: PANE_KEY, connectionId: null },
        lookup({ persistedPtyId: 'wt@@pty-1' })
      )
    ).toBe('acct-b')
  })

  it('leaves unpinned and SSH panes unstamped', () => {
    markPinnedClaudePtySpawned('pty-1', 'acct-b')
    expect(
      withPinnedClaudeAccount(
        { paneKey: PANE_KEY, connectionId: null },
        lookup({ livePtyId: 'pty-2', persistedPtyId: 'pty-1' })
      )
    ).toEqual({ paneKey: PANE_KEY, connectionId: null })
    expect(
      pinnedClaudeAccountIdForPane(
        { paneKey: PANE_KEY, connectionId: 'ssh-1' },
        lookup({ livePtyId: 'pty-1' })
      )
    ).toBeUndefined()
  })
})
