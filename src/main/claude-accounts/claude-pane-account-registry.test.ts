import { afterEach, describe, expect, it } from 'vitest'
import { bindClaudeAuthProxySlotToPty } from './claude-auth-proxy/claude-auth-proxy-slot-owners'
import {
  _internals,
  assignClaudePaneAccount,
  claudeAssignedAccountForProviderSession,
  claudeBillingAccountForPaneKey,
  forgetClaudePaneAccount,
  getClaudePaneAccount,
  inferClaudeAccountIdFromTranscript,
  listClaudePaneAccounts,
  listClaudePaneAccountsByAccount,
  onClaudePaneAssigned,
  recordClaudePaneAccount,
  rememberClaudeSessionAssignment,
  setClaudePaneProxySlotReleaser,
  type ClaudePaneAccountRecord
} from './claude-pane-account-registry'

function record(ptyId: string, accountId: string, pinned = false): ClaudePaneAccountRecord {
  return {
    ptyId,
    paneKey: `tab-${ptyId}:leaf-${ptyId}`,
    accountId,
    configDir: `/data/claude-profiles/${accountId}/home`,
    launchedAt: 1_000,
    pinned,
    source: pinned ? 'transcript' : 'spawn'
  }
}

describe('claude pane account registry', () => {
  afterEach(() => {
    _internals.reset()
  })

  it('publishes when the billed account changes and when the pane is forgotten', () => {
    const notices: { ptyId: string; accountId: string | null }[] = []
    const stop = onClaudePaneAssigned((notice) => {
      notices.push({ ptyId: notice.ptyId, accountId: notice.accountId })
    })
    recordClaudePaneAccount(record('pty-1', 'a'))
    recordClaudePaneAccount(record('pty-1', 'a'))
    assignClaudePaneAccount('pty-1', 'b')
    forgetClaudePaneAccount('pty-1')
    forgetClaudePaneAccount('missing')
    stop()
    recordClaudePaneAccount(record('pty-2', 'a'))
    expect(notices).toEqual([
      { ptyId: 'pty-1', accountId: 'a' },
      { ptyId: 'pty-1', accountId: 'b' },
      { ptyId: 'pty-1', accountId: null }
    ])
  })

  it('records, lists and forgets the account a PTY runs on', () => {
    recordClaudePaneAccount(record('pty-1', 'a'))
    recordClaudePaneAccount(record('pty-2', 'b'))
    recordClaudePaneAccount(record('pty-3', 'a', true))

    expect(getClaudePaneAccount('pty-1')).toEqual(record('pty-1', 'a'))
    expect(listClaudePaneAccounts().map((entry) => entry.ptyId)).toEqual([
      'pty-1',
      'pty-2',
      'pty-3'
    ])
    expect(listClaudePaneAccountsByAccount('a').map((entry) => entry.ptyId)).toEqual([
      'pty-1',
      'pty-3'
    ])

    forgetClaudePaneAccount('pty-1')
    expect(getClaudePaneAccount('pty-1')).toBeNull()
    expect(listClaudePaneAccountsByAccount('a').map((entry) => entry.ptyId)).toEqual(['pty-3'])
  })

  it('re-recording a PTY replaces its record (a restarted pane shows its new account)', () => {
    recordClaudePaneAccount(record('pty-1', 'a'))
    recordClaudePaneAccount({ ...record('pty-1', 'c'), launchedAt: 2_000 })
    expect(getClaudePaneAccount('pty-1')?.accountId).toBe('c')
    expect(listClaudePaneAccounts()).toHaveLength(1)
  })

  it('infers the account from where Claude writes its transcript', () => {
    const accounts = [
      { id: 'a', homes: ['/data/claude-profiles/a/home'] },
      { id: 'b', homes: ['/legacy/unused', '/data/claude-profiles/b/home/'] }
    ]
    expect(
      inferClaudeAccountIdFromTranscript(
        '/data/claude-profiles/b/home/projects/-Users-x-repo/4f2c.jsonl',
        accounts
      )
    ).toEqual({ accountId: 'b', configDir: '/data/claude-profiles/b/home' })
    // System default or any folder no managed account owns.
    expect(
      inferClaudeAccountIdFromTranscript(
        '/Users/x/.claude/projects/-Users-x-repo/4f2c.jsonl',
        accounts
      )
    ).toBeNull()
    // No transcript reported → the caller cannot know.
    expect(inferClaudeAccountIdFromTranscript(undefined, accounts)).toBeUndefined()
    expect(inferClaudeAccountIdFromTranscript('/no/projects/here.jsonl', accounts)).toBeUndefined()
  })

  it('ignores trailing slashes on the home and on the transcript folder', () => {
    const accounts = [{ id: 'b', homes: ['/data/claude-profiles/b/home/'] }]
    expect(
      inferClaudeAccountIdFromTranscript(
        '/data/claude-profiles/b/home/projects/-Users-x-repo/4f2c.jsonl',
        accounts
      )
    ).toEqual({ accountId: 'b', configDir: '/data/claude-profiles/b/home' })
    // A project folder (trailing slash, no file) is not a transcript: stricter than the renderer.
    expect(
      inferClaudeAccountIdFromTranscript(
        '/data/claude-profiles/b/home/projects/-Users-x-repo/',
        accounts
      )
    ).toBeUndefined()
  })

  it('bills the assigned account in place and remembers it after the pane is forgotten', () => {
    const entry = record('pty-1', 'a')
    entry.proxySlot = 'slot-1'
    recordClaudePaneAccount(entry)
    const released: string[] = []
    setClaudePaneProxySlotReleaser((slot) => released.push(slot))

    expect(assignClaudePaneAccount('pty-1', 'b', 'sess-1')).toBe(true)
    expect(assignClaudePaneAccount('missing', 'b')).toBe(false)
    expect(entry.assignedAccountId).toBe('b')
    expect(getClaudePaneAccount('pty-1')).toBe(entry)
    expect(listClaudePaneAccountsByAccount('b').map((item) => item.ptyId)).toEqual(['pty-1'])
    expect(listClaudePaneAccountsByAccount('a')).toEqual([])
    expect(claudeBillingAccountForPaneKey(entry.paneKey ?? '')).toBe('b')

    rememberClaudeSessionAssignment('sess-1', 'b')
    forgetClaudePaneAccount('pty-1')
    expect(released).toEqual(['slot-1'])
    expect(getClaudePaneAccount('pty-1')).toBeNull()
    expect(claudeAssignedAccountForProviderSession('sess-1')).toBe('b')
  })

  it('releases a proxy slot a re-record replaces, and a slot bound with no pane record', () => {
    const released: string[] = []
    setClaudePaneProxySlotReleaser((slot) => released.push(slot))
    recordClaudePaneAccount({ ...record('pty-1', 'a'), proxySlot: 'slot-1' })
    recordClaudePaneAccount({ ...record('pty-1', 'a'), proxySlot: 'slot-2' })
    expect(released).toEqual(['slot-1'])

    bindClaudeAuthProxySlotToPty('shell-slot', 'pty-shell')
    forgetClaudePaneAccount('pty-shell')
    forgetClaudePaneAccount('pty-1')
    expect(released).toEqual(['slot-1', 'shell-slot', 'slot-2'])
    expect(getClaudePaneAccount('pty-shell')).toBeNull()
  })

  it('keeps folder routing when the assignment still matches the spawn account', () => {
    const entry = record('pty-1', 'a')
    entry.assignedAccountId = 'a'
    recordClaudePaneAccount(entry)
    expect(claudeBillingAccountForPaneKey(entry.paneKey ?? '')).toBeNull()
  })
})
