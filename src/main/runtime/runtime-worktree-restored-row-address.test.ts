import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from './terminal/records/runtime-terminal-state-records'
import { applyRuntimeWorktreePsSessionActivity } from './workspaces/process-listing/runtime-worktree-ps-activity'
import { collectRuntimeWorktreePtyAgentSources } from './workspaces/process-listing/runtime-worktree-pty-agent-sources'

// A hook row restored after a restart has no handle of its own; the pane's live PTY may have one.
const TAB = 'tab-1'
const PANE = makePaneKey(TAB, '11111111-1111-4111-8111-111111111111')
const OTHER_PANE = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

type Pty = { ptyId: string; spawnPaneKey: string | null; paneKey: string }

function restoredRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: source collection reads only the fields set here.
  return {
    paneKey: PANE,
    tabId: TAB,
    worktreeId: 'wt-1',
    connectionId: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'fix the flaky test',
    stateStartedAt: 1,
    receivedAt: 1,
    ...overrides
  } as AgentStatusIpcPayload
}

/** Terminals still in the pane they exported, as after an ordinary restart. */
const inPane = (...ptyIds: string[]): Pty[] =>
  ptyIds.map((ptyId) => ({ ptyId, spawnPaneKey: PANE, paneKey: PANE }))

function sourcesFor(args: {
  ptys: Pty[]
  handlesByPty: Record<string, string[]>
  row?: AgentStatusIpcPayload
}) {
  const ptysById = new Map(
    args.ptys.map((pty) => [
      pty.ptyId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence pass reads only ptyId, connected and spawnPaneKey.
      {
        ptyId: pty.ptyId,
        connected: true,
        spawnPaneKey: pty.spawnPaneKey
      } as unknown as RuntimePtyWorktreeRecord
    ])
  )
  const paneKeyOf = new Map(args.ptys.map((pty) => [pty.ptyId, pty.paneKey]))
  const getTerminalHandlesForPty = vi.fn((ptyId: string) => args.handlesByPty[ptyId] ?? [])
  const { mirroredWorktreeIdByTabId, connectedPtyEvidence } = applyRuntimeWorktreePsSessionActivity(
    {
      store: null,
      summaries: new Map(),
      repoById: new Map(),
      ptysById,
      tabs: new Map(),
      paneOf: (pty) => {
        const paneKey = paneKeyOf.get(pty.ptyId) ?? null
        return { tabId: paneKey?.split(':')[0] ?? null, paneKey, recordedAtGraphSequence: 0 }
      },
      getTerminalHandlesForPty,
      getSummary: () => null
    }
  )
  const sources = collectRuntimeWorktreePtyAgentSources({
    hookSnapshots: [args.row ?? restoredRow()],
    mirroredWorktreeIdByTabId,
    connectedPtyEvidence
  })
  return { source: sources[0], getTerminalHandlesForPty }
}

describe('a restored hook row on a live pane', () => {
  it("takes the handle already bound to its pane's one connected PTY", () => {
    const { source } = sourcesFor({ ptys: inPane('pty-1'), handlesByPty: { 'pty-1': ['term_a'] } })
    expect(source).toMatchObject({ terminalHandle: 'term_a', ptyId: 'pty-1', hasLivePty: true })
  })

  it('stays live without a handle when none is bound, and the listing mints none', () => {
    const { source, getTerminalHandlesForPty } = sourcesFor({
      ptys: inPane('pty-1'),
      handlesByPty: {}
    })
    expect(source?.terminalHandle).toBeUndefined()
    expect(source?.hasLivePty).toBe(true)
    // Only the non-minting lookup is ever handed in; it was asked, and returned nothing.
    expect(getTerminalHandlesForPty).toHaveBeenCalledWith('pty-1')
  })

  it('gets no handle when two connected PTYs claim its pane', () => {
    const { source } = sourcesFor({
      ptys: inPane('pty-1', 'pty-2'),
      handlesByPty: { 'pty-1': ['term_a'], 'pty-2': ['term_b'] }
    })
    expect(source?.terminalHandle).toBeUndefined()
  })

  it('gets no handle when its pane now shows another terminal and its own was re-homed', () => {
    // The agent's terminal exported PANE but shows in OTHER_PANE; another terminal now shows PANE.
    const { source } = sourcesFor({
      ptys: [
        { ptyId: 'pty-original', spawnPaneKey: PANE, paneKey: OTHER_PANE },
        { ptyId: 'pty-other', spawnPaneKey: null, paneKey: PANE }
      ],
      handlesByPty: { 'pty-original': ['term_original'], 'pty-other': ['term_other'] }
    })
    expect(source?.terminalHandle).toBeUndefined()
  })

  it('gets no handle from a terminal whose exported pane is unknown', () => {
    const { source } = sourcesFor({
      ptys: [{ ptyId: 'pty-1', spawnPaneKey: null, paneKey: PANE }],
      handlesByPty: { 'pty-1': ['term_a'] }
    })
    expect(source?.terminalHandle).toBeUndefined()
  })

  it('keeps the handle a live hook row reported itself', () => {
    const { source } = sourcesFor({
      ptys: inPane('pty-1'),
      handlesByPty: { 'pty-1': ['term_a', 'term_own'] },
      row: restoredRow({ terminalHandle: 'term_own' })
    })
    expect(source?.terminalHandle).toBe('term_own')
  })
})
