import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunAccount } from '../../shared/agent-run-account'
import type { AgentRunAccountRow } from '../agent-hooks/server/server-run-account'
import {
  _internals as codexRegistryInternals,
  getCodexPaneAccount,
  recordCodexPaneAccount,
  setCodexPaneKept,
  type CodexPaneAccountRecord
} from '../codex/codex-pane-account-registry'
import {
  keepStaleCodexPanesAndConversations,
  setAgentKept,
  type AgentKeepDeps
} from './agent-account-keep'
import { resolveAgentLaunchAccount } from './agent-launch-account'
import { KeptAgentConversations } from './kept-agent-conversations'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'

const CODEX_FACET: AgentRunAccount = {
  provider: 'codex',
  lane: 'host',
  accountId: 'acc-a',
  mode: 'follow'
}
const CLAUDE_FACET: AgentRunAccount = {
  provider: 'claude',
  lane: 'host',
  accountId: 'acc-b',
  mode: 'follow',
  shellRoute: 'selected'
}

function row(overrides: Partial<AgentRunAccountRow> = {}): AgentRunAccountRow {
  return {
    paneKey: PANE,
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 's1', transcriptPath: '/t/s1.jsonl' },
    runAccount: CODEX_FACET,
    connectionId: null,
    ...overrides
  }
}

function deps(overrides: Partial<AgentKeepDeps> = {}) {
  const record: CodexPaneAccountRecord = {
    selectionKey: 'host',
    accountId: 'acc-a',
    homeRoute: 'account-home'
  }
  const kept = { keep: vi.fn(), release: vi.fn(), acceptsChanges: vi.fn(() => true) }
  const base: AgentKeepDeps = {
    getRow: vi.fn(() => row()),
    refresh: vi.fn((): AgentRunAccount => ({ ...CODEX_FACET, mode: 'kept' })),
    withdraw: vi.fn(),
    kept,
    getPtyIdForPaneKey: vi.fn((paneKey: string) => (paneKey === PANE ? 'pty-1' : undefined)),
    getPaneKeyForPty: vi.fn((ptyId: string) => (ptyId === 'pty-1' ? PANE : undefined)),
    readCodexRecord: vi.fn(() => record),
    setCodexPaneKept: vi.fn(() => 'kept' as const),
    keepStaleCodexPanes: vi.fn((ptyIds: readonly string[]) => [...ptyIds]),
    now: () => 7,
    ...overrides
  }
  return { ...base, kept }
}

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  codexRegistryInternals.resetCache()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('setAgentKept', () => {
  it('keeps a Codex pane and its conversation on the account it launched under', () => {
    const d = deps()
    expect(setAgentKept(d, { paneKey: PANE, ptyId: 'pty-1', kept: true })).toEqual({
      ok: true,
      runAccount: { ...CODEX_FACET, mode: 'kept' }
    })
    expect(d.setCodexPaneKept).toHaveBeenCalledWith('pty-1', true)
    expect(d.kept.keep).toHaveBeenCalledWith('codex', 's1', {
      lane: 'host',
      accountId: 'acc-a',
      keptAt: 7,
      transcriptPath: '/t/s1.jsonl'
    })
    expect(d.refresh).toHaveBeenCalledWith(PANE)
  })

  it('releases a Codex pane and its conversation', () => {
    const d = deps({ refresh: vi.fn(() => CODEX_FACET) })
    expect(setAgentKept(d, { paneKey: PANE, kept: false })).toEqual({
      ok: true,
      runAccount: CODEX_FACET
    })
    expect(d.setCodexPaneKept).toHaveBeenCalledWith('pty-1', false)
    expect(d.kept.release).toHaveBeenCalledWith('codex', 's1')
    expect(d.kept.keep).not.toHaveBeenCalled()
    expect(d.withdraw).not.toHaveBeenCalled()
  })

  it('un-keeps a refused kept Codex resume, which has no terminal, so it can resume again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-unkeep-'))
    dirs.push(dir)
    const index = new KeptAgentConversations({ filePath: join(dir, 'kept.json') })
    index.keep('codex', 's1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    const keptFacet: AgentRunAccount = { ...CODEX_FACET, mode: 'kept' }
    const d = deps({
      getRow: vi.fn(() => row({ runAccount: keptFacet })),
      getPtyIdForPaneKey: vi.fn(() => undefined),
      readCodexRecord: vi.fn(() => null),
      // With no launch record the producer can only restate the stored facet.
      refresh: vi.fn(() => keptFacet)
    })

    expect(
      setAgentKept({ ...d, kept: index }, { paneKey: PANE, ptyId: 'pty-gone', kept: false })
    ).toEqual({
      ok: true,
      runAccount: null
    })
    expect(d.setCodexPaneKept).not.toHaveBeenCalled()
    expect(d.withdraw).toHaveBeenCalledWith(PANE)
    expect(
      resolveAgentLaunchAccount({
        connectionId: null,
        launchAgent: 'codex',
        resumeProviderSession: { key: 'session_id', id: 's1' },
        lane: 'host',
        kept: index,
        settings: { claudeManagedAccounts: [], codexManagedAccounts: [] }
      })
    ).toEqual({ kind: 'follow' })
  })

  it('reports a released Claude agent no runtime is observing as released, not failed', () => {
    const d = deps({
      getRow: vi.fn(() =>
        row({ agentType: 'claude', runAccount: { ...CLAUDE_FACET, mode: 'kept' } })
      ),
      getPtyIdForPaneKey: vi.fn(() => undefined),
      refresh: vi.fn(() => null)
    })
    expect(setAgentKept(d, { paneKey: PANE, kept: false })).toEqual({ ok: true, runAccount: null })
    expect(d.kept.release).toHaveBeenCalledWith('claude', 's1')
  })

  it('refuses a Codex pane whose home cannot be kept, without touching anything', () => {
    const d = deps({
      readCodexRecord: vi.fn(() => ({
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home' as const
      }))
    })
    expect(setAgentKept(d, { paneKey: PANE, kept: true })).toEqual({
      ok: false,
      reason: 'not-keepable'
    })
    expect(d.setCodexPaneKept).not.toHaveBeenCalled()
    expect(d.kept.keep).not.toHaveBeenCalled()
  })

  it('refuses to keep while a newer Orca owns the list, touching nothing', () => {
    const d = deps()
    d.kept.acceptsChanges.mockReturnValue(false)
    expect(setAgentKept(d, { paneKey: PANE, kept: true })).toEqual({
      ok: false,
      reason: 'read-only'
    })
    expect(d.setCodexPaneKept).not.toHaveBeenCalled()
    expect(d.kept.keep).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a Claude conversation',
      { getRow: vi.fn(() => row({ agentType: 'claude', runAccount: CLAUDE_FACET })) }
    ],
    [
      'a Codex conversation with no launch record',
      { setCodexPaneKept: vi.fn(() => 'no-record' as const) }
    ]
  ])('refuses to un-keep %s while a newer Orca owns the list, touching nothing', (_l, over) => {
    const d = deps(over)
    d.kept.acceptsChanges.mockReturnValue(false)
    expect(setAgentKept(d, { paneKey: PANE, kept: false })).toEqual({
      ok: false,
      reason: 'read-only'
    })
    expect(d.kept.release).not.toHaveBeenCalled()
    expect(d.withdraw).not.toHaveBeenCalled()
  })

  it('un-keeps a Codex pane kept in its launch registry while a newer Orca owns the list', () => {
    const launched: CodexPaneAccountRecord = {
      selectionKey: 'host',
      accountId: 'acc-a',
      homeRoute: 'account-home'
    }
    let record: CodexPaneAccountRecord = { ...launched, kept: true }
    const d = deps({
      getRow: vi.fn(() => row({ runAccount: { ...CODEX_FACET, mode: 'kept' } })),
      readCodexRecord: vi.fn(() => record),
      setCodexPaneKept: vi.fn((_ptyId: string, kept: boolean) => {
        record = kept ? { ...launched, kept: true } : launched
        return kept ? ('kept' as const) : ('released' as const)
      }),
      refresh: vi.fn((): AgentRunAccount => ({
        ...CODEX_FACET,
        mode: record.kept ? 'kept' : 'follow'
      }))
    })
    d.kept.acceptsChanges.mockReturnValue(false)
    expect(setAgentKept(d, { paneKey: PANE, kept: false })).toEqual({
      ok: true,
      runAccount: CODEX_FACET
    })
    expect(record.kept).toBeUndefined()
    expect(d.kept.release).not.toHaveBeenCalled()
    expect(d.withdraw).not.toHaveBeenCalled()
  })

  it.each([
    ['keeping', true, 'keep'],
    ['un-keeping', false, 'release']
  ] as const)(
    'reports an unreadable launch registry when %s, leaving the list alone',
    (_l, kept, op) => {
      const d = deps({ setCodexPaneKept: vi.fn(() => 'unavailable' as const) })
      expect(setAgentKept(d, { paneKey: PANE, kept })).toEqual({
        ok: false,
        reason: 'unavailable'
      })
      expect(d.kept[op]).not.toHaveBeenCalled()
      expect(d.withdraw).not.toHaveBeenCalled()
    }
  )

  it.each([[true], [false]])(
    'un-keeping against an unreadable real launch registry leaves the keep in place (list writable: %s)',
    (listWritable) => {
      const userData = mkdtempSync(join(tmpdir(), 'orca-unkeep-registry-'))
      dirs.push(userData)
      vi.stubEnv('ORCA_USER_DATA_PATH', userData)
      codexRegistryInternals.resetCache()
      const registryFile = join(userData, 'codex-pane-accounts.json')
      recordCodexPaneAccount('pty-1', {
        selectionKey: 'host',
        accountId: 'acc-a',
        homeRoute: 'account-home'
      })
      expect(setCodexPaneKept('pty-1', true)).toBe('kept')
      const persisted = readFileSync(registryFile, 'utf-8')
      rmSync(registryFile)
      // Why: a directory in the file's place fails the read with EISDIR, not absence.
      mkdirSync(registryFile)
      codexRegistryInternals.resetCache()
      const d = deps({
        getRow: vi.fn(() => row({ runAccount: { ...CODEX_FACET, mode: 'kept' } })),
        readCodexRecord: getCodexPaneAccount,
        setCodexPaneKept
      })
      d.kept.acceptsChanges.mockReturnValue(listWritable)

      expect(setAgentKept(d, { paneKey: PANE, kept: false })).toEqual({
        ok: false,
        reason: 'unavailable'
      })
      expect(d.kept.release).not.toHaveBeenCalled()
      expect(d.withdraw).not.toHaveBeenCalled()
      rmSync(registryFile, { recursive: true })
      writeFileSync(registryFile, persisted)
      expect(getCodexPaneAccount('pty-1')).toMatchObject({ kept: true })
    }
  )

  it('refuses a terminal that is not the one the request names', () => {
    const d = deps()
    expect(setAgentKept(d, { paneKey: PANE, ptyId: 'pty-9', kept: true })).toEqual({
      ok: false,
      reason: 'unknown-pane'
    })
    expect(d.setCodexPaneKept).not.toHaveBeenCalled()
  })

  it.each([
    ['a relay row', row({ connectionId: 'ssh-1' })],
    ['a row with no account facet', row({ runAccount: undefined })],
    ['no row', null]
  ])('refuses %s', (_label, current) => {
    const d = deps({ getRow: vi.fn(() => current) })
    expect(setAgentKept(d, { paneKey: PANE, kept: true })).toEqual({
      ok: false,
      reason: 'unknown-pane'
    })
  })

  it('keeps a Claude conversation on the account its row says it runs on', () => {
    const d = deps({
      getRow: vi.fn(() => row({ agentType: 'claude', runAccount: CLAUDE_FACET })),
      refresh: vi.fn(() => ({ ...CLAUDE_FACET, mode: 'kept' as const }))
    })
    expect(setAgentKept(d, { paneKey: PANE, kept: true })).toMatchObject({ ok: true })
    expect(d.kept.keep).toHaveBeenCalledWith('claude', 's1', {
      lane: 'host',
      accountId: 'acc-b',
      keptAt: 7,
      transcriptPath: '/t/s1.jsonl'
    })
    expect(d.setCodexPaneKept).not.toHaveBeenCalled()
  })

  it('waits for a Claude agent to report its session before keeping it', () => {
    const d = deps({
      getRow: vi.fn(() =>
        row({ agentType: 'claude', runAccount: CLAUDE_FACET, providerSession: undefined })
      )
    })
    expect(setAgentKept(d, { paneKey: PANE, kept: true })).toEqual({
      ok: false,
      reason: 'no-session'
    })
    expect(d.kept.keep).not.toHaveBeenCalled()
  })
})

describe('keepStaleCodexPanesAndConversations', () => {
  it('keeps the conversation of each pane the registry kept, found by pty when needed', () => {
    const d = deps({ keepStaleCodexPanes: vi.fn(() => ['pty-1']) })
    keepStaleCodexPanesAndConversations(d, [
      // A stale pane key from the renderer still resolves through the pty.
      { ptyId: 'pty-1', paneKey: OTHER_PANE },
      { ptyId: 'pty-2' }
    ])
    expect(d.keepStaleCodexPanes).toHaveBeenCalledWith(['pty-1', 'pty-2'])
    expect(d.getRow).toHaveBeenCalledWith(PANE)
    expect(d.kept.keep).toHaveBeenCalledTimes(1)
    expect(d.kept.keep).toHaveBeenCalledWith(
      'codex',
      's1',
      expect.objectContaining({ accountId: 'acc-a' })
    )
    expect(d.refresh).toHaveBeenCalledWith(PANE)
  })

  it('keeps no conversation for a pane the registry could not keep', () => {
    const d = deps({ keepStaleCodexPanes: vi.fn(() => []) })
    keepStaleCodexPanesAndConversations(d, [{ ptyId: 'pty-1', paneKey: PANE }])
    expect(d.kept.keep).not.toHaveBeenCalled()
  })
})
