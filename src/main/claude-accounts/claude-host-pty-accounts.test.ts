import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _internals,
  attachClaudeHostPtyAccountPersistence,
  countHostClaudePtysForAccount,
  createClaudeHostPtyAccountFilePersistence,
  forgetHostClaudePtyAccount,
  hostClaudeAccountIdFromProvenance,
  readClaudeHostPtyAccountsFile,
  recordHostClaudePtyAccount,
  seedHostClaudePtyAccounts,
  setClaudeActiveHostAccountResolver
} from './claude-host-pty-accounts'
import {
  hasLiveClaudePtys,
  markClaudePtyExited,
  markClaudePtySpawned,
  markClaudeStructuredChildExited,
  markClaudeStructuredChildSpawned,
  seedLiveClaudePtysFromPersistence,
  confirmSeededClaudeLivePtys
} from './live-pty-gate'
import {
  _internals as pinnedRegistryReset,
  releaseClaudePinnedAccountReservation,
  reserveClaudePinnedAccount
} from './claude-pinned-pty-registry'

describe('host Claude PTY account attribution', () => {
  afterEach(() => {
    _internals.reset()
    pinnedRegistryReset.reset()
  })

  it('reads the host account only from an unsuffixed managed provenance', () => {
    expect(hostClaudeAccountIdFromProvenance('managed:acct-x')).toBe('acct-x')
    expect(hostClaudeAccountIdFromProvenance('managed:acct-x:pinned')).toBeNull()
    expect(hostClaudeAccountIdFromProvenance('managed:acct-x:wsl:Ubuntu')).toBeNull()
    expect(hostClaudeAccountIdFromProvenance('system')).toBeNull()
  })

  it('blocks a pinned launch of X while a host Claude started on X runs, and only X', () => {
    markClaudePtySpawned('old-x', 'managed:acct-x')
    markClaudePtySpawned('other-y', 'managed:acct-y')
    markClaudePtySpawned('system', 'system')

    expect(hasLiveClaudePtys()).toBe(true)
    expect(reserveClaudePinnedAccount('acct-x')).toBe('host-sessions')
    expect(reserveClaudePinnedAccount('acct-z')).toBeNull()
    releaseClaudePinnedAccountReservation('acct-z')

    markClaudePtyExited('old-x')
    expect(countHostClaudePtysForAccount('acct-x')).toBe(0)
    expect(reserveClaudePinnedAccount('acct-x')).toBeNull()
    releaseClaudePinnedAccountReservation('acct-x')
    markClaudePtyExited('other-y')
    markClaudePtyExited('system')
  })

  it('attributes launches without provenance and structured children to the selected account', () => {
    setClaudeActiveHostAccountResolver(() => 'acct-x')
    markClaudePtySpawned('no-provenance')
    markClaudeStructuredChildSpawned('child-1')
    expect(countHostClaudePtysForAccount('acct-x')).toBe(2)

    markClaudeStructuredChildExited('child-1')
    markClaudePtyExited('no-provenance')
    expect(countHostClaudePtysForAccount('acct-x')).toBe(0)
  })

  it('restores recorded accounts, falls back to the selected one, and forgets dead seeds', () => {
    setClaudeActiveHostAccountResolver(() => 'acct-now')
    seedLiveClaudePtysFromPersistence(['recorded', 'legacy', 'dead'])
    seedHostClaudePtyAccounts(['recorded', 'legacy', 'dead'], {
      recorded: 'acct-x',
      dead: 'acct-x'
    })
    expect(countHostClaudePtysForAccount('acct-x')).toBe(2)
    expect(countHostClaudePtysForAccount('acct-now')).toBe(1)

    confirmSeededClaudeLivePtys(['recorded', 'legacy'])

    expect(countHostClaudePtysForAccount('acct-x')).toBe(1)
    markClaudePtyExited('recorded')
    markClaudePtyExited('legacy')
  })

  it('persists terminal PTYs but never structured children', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-claude-host-pty-'))
    try {
      const filePath = join(dir, 'claude-host-pane-accounts.json')
      attachClaudeHostPtyAccountPersistence(createClaudeHostPtyAccountFilePersistence(filePath))
      recordHostClaudePtyAccount('pty-1', 'acct-x', { persist: true })
      recordHostClaudePtyAccount('pty-2', null, { persist: true })
      recordHostClaudePtyAccount('claude-structured:1', 'acct-x', { persist: false })

      expect(readClaudeHostPtyAccountsFile(filePath)).toEqual({ 'pty-1': 'acct-x', 'pty-2': null })

      forgetHostClaudePtyAccount('pty-1')
      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
        version: 1,
        panes: { 'pty-2': null }
      })
      writeFileSync(filePath, '{"panes":{"a":7,"b":"acct-y"}}')
      expect(readClaudeHostPtyAccountsFile(filePath)).toEqual({ b: 'acct-y' })
      writeFileSync(filePath, 'garbage')
      expect(readClaudeHostPtyAccountsFile(filePath)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
