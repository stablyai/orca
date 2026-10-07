import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import {
  pendingAgentSessionOperationRow,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict,
  trackRunningAgentLaunchPane,
  type AgentLaunchPaneEvidence
} from './agent-launch-pane-attachment'

const PANE = { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }
const NOW = Date.now()
let rowCounter = 0

function row(
  outcome: AgentSessionOperationOutcome,
  overrides: Partial<AgentSessionOperationRow> = {}
): AgentSessionOperationRow {
  rowCounter += 1
  return {
    ...pendingAgentSessionOperationRow({
      callerKey: 'caller',
      operationId: `${NOW}-${rowCounter.toString(16).padStart(32, '0')}`,
      fingerprint: 'fp',
      now: NOW
    }),
    outcome,
    ownedPane: PANE,
    ...overrides
  }
}

function terminalLaunch(paneKey: string): AgentLaunchResult {
  return {
    outcome: { kind: 'terminal', handle: 'term_1', paneKey },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: '' }
  }
}

const SUCCEEDED_HERE: AgentSessionOperationOutcome = {
  status: 'succeeded',
  sessionId: '',
  launch: terminalLaunch(PANE.paneKey)
}

function evidence(
  rows: AgentSessionOperationRow[] | null,
  overrides: Partial<AgentLaunchPaneEvidence> = {}
): AgentLaunchPaneEvidence {
  return {
    isPaneLive: () => false,
    openedRows: () => rows,
    launchPaneOnTab: () => null,
    openRows: async () => rows ?? [],
    now: () => NOW,
    ...overrides
  }
}

async function verdictFor(found: AgentLaunchPaneEvidence) {
  return (await resolveAgentLaunchPaneVerdict(PANE, found)) ?? { kind: 'no-check' }
}

describe('a pane an agent launch laid out', () => {
  afterEach(() => {
    resetAgentLaunchPanesForTests()
  })

  it('costs a pane nothing launches into not even a wait', () => {
    expect(resolveAgentLaunchPaneVerdict(PANE, evidence([]))).toBeNull()
    expect(
      resolveAgentLaunchPaneVerdict(PANE, evidence([row({ status: 'failed', code: 'x' })]))
    ).not.toBeNull()
    expect(resolveAgentLaunchPaneVerdict(PANE, evidence(null))).toBeNull()
  })

  it('waits for the launch running in this process, then reads how it ended off the record', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const rows: AgentSessionOperationRow[] = []
    const verdict = resolveAgentLaunchPaneVerdict(PANE, evidence(rows))
    expect(verdict).not.toBeNull()

    rows.push(row({ status: 'failed', code: 'agent_session_exited_during_start' }))
    running.finish({ tabTakenBack: false })

    await expect(verdict).resolves.toEqual({
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
  })

  it("hears the user's close only while the pane's launch is running", () => {
    const tabId = 'tab-closing'
    const leafId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId })
    const running = trackRunningAgentLaunchPane({
      worktreeId: 'wt-1',
      paneKey: `${tabId}:${leafId}`
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId: 'tab-other' })
    markAgentLaunchesClosedByUser('wt-1', {
      kind: 'pane',
      tabId,
      leafId: '6fa459ea-ee8a-4ca4-894e-db77e160355e'
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'pane', tabId, leafId })
    expect(running.closedByUser()).toBe(true)
  })

  it('never offers a shell in a tab the host is taking back', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, evidence([]))
    running.finish({ tabTakenBack: true })
    await expect(verdict).resolves.toEqual({ kind: 'withdrawn' })
  })

  it('attaches to a process that holds the pane, whatever the record says', async () => {
    const live = { isPaneLive: () => true }
    await expect(verdictFor(evidence([row({ status: 'unknown' })], live))).resolves.toEqual({
      kind: 'proceed'
    })
    await expect(
      verdictFor(evidence([row({ status: 'failed', code: 'x' })], live))
    ).resolves.toEqual({ kind: 'proceed' })
  })

  it.each([
    [
      'a failed launch: not started, with its reason',
      [row({ status: 'failed', code: 'boom' })],
      { kind: 'not-started', code: 'boom' }
    ],
    [
      'an outcome nobody knows: unconfirmed, never a failure',
      [row({ status: 'unknown' })],
      { kind: 'unconfirmed' }
    ],
    [
      'a launch that ran into another surface: withdrawn',
      [row({ status: 'succeeded', sessionId: 's-1', launch: terminalLaunch('other:pane') })],
      { kind: 'withdrawn' }
    ],
    [
      'an agent that ran here and is gone: an ordinary terminal',
      [row(SUCCEEDED_HERE)],
      { kind: 'proceed' }
    ],
    [
      'an expired row owns nothing',
      [row({ status: 'failed', code: 'boom' }, { expiresAt: NOW - 1 })],
      { kind: 'no-check' }
    ],
    [
      'a refused second launch never overrides the one that ran here',
      [
        row(SUCCEEDED_HERE, { recordedAt: NOW }),
        row({ status: 'failed', code: 'agent_launch_pane_already_live' }, { recordedAt: NOW + 1 })
      ],
      { kind: 'proceed' }
    ],
    [
      'another pane of the same tab is not owned',
      [
        row(
          { status: 'failed', code: 'boom' },
          { ownedPane: { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-2' } }
        )
      ],
      { kind: 'no-check' }
    ]
  ] as const)('%s', async (_name, rows, expected) => {
    await expect(verdictFor(evidence([...rows]))).resolves.toEqual(expected)
  })

  it('after a restart, opens the record for a pane whose launch was still open', async () => {
    const restarted = evidence(null, {
      launchPaneOnTab: () => ({}),
      openRows: async () => [row({ status: 'unknown' })]
    })
    await expect(verdictFor(restarted)).resolves.toEqual({ kind: 'unconfirmed' })
  })

  it("answers from the tab once its pane's fate is final, without the record and past its expiry", async () => {
    const openRows = vi.fn(async () => [])
    const restarted = evidence(null, {
      launchPaneOnTab: () => ({ outcome: { kind: 'not-started', code: 'boom' } }),
      openRows
    })
    await expect(verdictFor(restarted)).resolves.toEqual({ kind: 'not-started', code: 'boom' })
    expect(openRows).not.toHaveBeenCalled()
  })

  it('adopts a process its persisted binding names, even over a final "couldn\'t confirm"', async () => {
    const survived = evidence(null, {
      isPaneLive: () => true,
      launchPaneOnTab: () => ({ outcome: { kind: 'unconfirmed' } })
    })
    await expect(verdictFor(survived)).resolves.toEqual({ kind: 'proceed' })
  })

  it('settles a pane no record names as an ordinary terminal, so its tab can forget the launch', async () => {
    const orphaned = evidence(null, { launchPaneOnTab: () => ({}), openRows: async () => [] })
    await expect(verdictFor(orphaned)).resolves.toEqual({ kind: 'proceed' })
  })

  it('reads nothing for a pane whose tab keeps nothing and no record row names', () => {
    const openRows = vi.fn(async () => [])
    expect(resolveAgentLaunchPaneVerdict(PANE, evidence(null, { openRows }))).toBeNull()
    expect(openRows).not.toHaveBeenCalled()
  })

  it('leaves an ordinary terminal when the record cannot be read: bookkeeping never gates the pane', async () => {
    const unreadable = evidence(null, {
      launchPaneOnTab: () => ({}),
      openRows: () => Promise.reject(new Error('journal_open_refused'))
    })
    await expect(verdictFor(unreadable)).resolves.toEqual({ kind: 'proceed' })
  })
})
