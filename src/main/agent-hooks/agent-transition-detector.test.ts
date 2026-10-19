import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { AgentTransitionDetector, type AgentPaneChange } from './agent-transition-detector'
import {
  AGENT_TRANSITION_SCENARIOS,
  type AgentTransitionStep
} from '../../shared/agent-transitions.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const OTHER_WT = 'repo-1::/tmp/b'
const FOLDER = 'folder:11111111-1111-4111-8111-111111111111'
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const NOW = 1_000_000

function createHarness() {
  const changes: AgentPaneChange[] = []
  const observations: AgentPaneChange[] = []
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    now: () => NOW
  })
  detector.subscribe((change) => (change.kind === 'observed' ? observations : changes).push(change))
  return { detector, changes, observations, server: new AgentHookServer() }
}

function ingest(
  server: AgentHookServer,
  row: AgentTransitionStep['row'],
  workspace: { worktreeId?: string; connectionId?: string } = {}
): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-a',
    worktreeId: workspace.worktreeId ?? WT,
    ...(workspace.connectionId ? { connectionId: workspace.connectionId } : {}),
    payload: { ...row, prompt: 'task', agentType: 'codex' }
  })
}

describe('AgentTransitionDetector', () => {
  it.each(AGENT_TRANSITION_SCENARIOS)('$name', ({ steps }) => {
    const h = createHarness()
    h.detector.attach(h.server)
    for (const { row, transition } of steps) {
      h.changes.length = 0
      ingest(h.server, row)
      const emitted = h.changes.flatMap((change) =>
        change.kind === 'moved' && change.transition ? [change.transition] : []
      )
      expect(emitted).toEqual(transition ? [transition] : [])
    }
  })

  it('names the pane and its host-qualified workspace: local, SSH host, folder', () => {
    const h = createHarness()
    h.detector.attach(h.server)
    ingest(h.server, { state: 'working' }, { connectionId: 'build-box' })
    expect(h.changes).toEqual([
      {
        kind: 'moved',
        paneKey: PANE,
        workspace: { worktreeId: WT, sshHostId: 'ssh:build-box' },
        from: 'rest',
        to: 'working',
        at: NOW,
        transition: 'prompt-submitted'
      }
    ])
    h.changes.length = 0
    ingest(h.server, { state: 'done' }, { worktreeId: FOLDER })
    // Moving workspace rests the pane where it was; a done with no turn there is no finish.
    expect(h.changes).toEqual([
      {
        kind: 'moved',
        paneKey: PANE,
        workspace: { worktreeId: WT, sshHostId: 'ssh:build-box' },
        from: 'working',
        to: 'rest',
        at: NOW,
        transition: null
      }
    ])
    h.changes.length = 0
    ingest(h.server, { state: 'blocked' }, { worktreeId: OTHER_WT })
    expect(h.changes.at(-1)).toMatchObject({
      workspace: { worktreeId: OTHER_WT, sshHostId: null },
      transition: 'needs-input'
    })
  })

  it('seeds a status present at attach, never as a transition', () => {
    const h = createHarness()
    ingest(h.server, { state: 'working' })
    h.detector.attach(h.server)
    const startedAt = h.server.getStatusSnapshot()[0].stateStartedAt
    expect(h.changes).toEqual([
      {
        kind: 'seeded',
        paneKey: PANE,
        workspace: { worktreeId: WT, sshHostId: null },
        phase: 'working',
        at: startedAt
      }
    ])
    // The seeded turn is known, so its finish is news.
    ingest(h.server, { state: 'done' })
    expect(h.changes.at(-1)).toMatchObject({ kind: 'moved', transition: 'turn-finished' })
  })

  it('seeds rows hydrated without a mutation once asked, and only those', () => {
    const h = createHarness()
    const source = new AgentHookServer()
    ingest(source, { state: 'working' })
    let hydrated = false
    h.detector.attach({
      getStatusSnapshot: () => (hydrated ? source.getStatusSnapshot() : []),
      getStatusSnapshotForPane: (paneKey) =>
        hydrated ? source.getStatusSnapshotForPane(paneKey) : [],
      subscribeStatusRowMutations: (listener) => source.subscribeStatusRowMutations(listener)
    })
    hydrated = true
    h.detector.seedRestoredRows()
    h.detector.seedRestoredRows()
    expect(h.changes.map((change) => change.kind)).toEqual(['seeded'])
    ingest(source, { state: 'done' })
    expect(h.changes.at(-1)).toMatchObject({ transition: 'turn-finished' })
  })

  it('rests a pane whose row goes, and reports whether hooks own a pane', () => {
    const h = createHarness()
    h.detector.attach(h.server)
    ingest(h.server, { state: 'blocked' })
    expect(h.detector.hasHookRow(PANE)).toBe(true)
    h.changes.length = 0
    h.server.clearPaneState(PANE)
    expect(h.detector.hasHookRow(PANE)).toBe(false)
    expect(h.changes).toEqual([
      expect.objectContaining({ kind: 'moved', from: 'needs-you', to: 'rest', transition: null })
    ])
  })

  it('still tells every reader when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detector = new AgentTransitionDetector({
      resolveTabWorktreeId: () => undefined,
      now: () => NOW
    })
    const received: AgentPaneChange[] = []
    detector.subscribe(() => {
      throw new Error('reader failed')
    })
    detector.subscribe((change) => received.push(change))
    const server = new AgentHookServer()
    detector.attach(server)
    try {
      ingest(server, { state: 'working' })
      expect(received.map((change) => change.kind)).toEqual(['observed', 'moved'])
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  it('reports every live look at a pane, changed or not, with or without a workspace', () => {
    const h = createHarness()
    h.detector.attach(h.server)
    ingest(h.server, { state: 'working' })
    ingest(h.server, { state: 'done', interrupted: true })
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      payload: { state: 'done', prompt: 'next', agentType: 'codex' }
    })
    h.server.clearPaneState(PANE)
    const workspace = { worktreeId: WT, sshHostId: null }
    expect(h.observations).toEqual([
      { kind: 'observed', paneKey: PANE, workspace, phase: 'working', at: NOW },
      { kind: 'observed', paneKey: PANE, workspace, phase: 'rest', at: NOW },
      { kind: 'observed', paneKey: PANE, workspace: null, phase: 'done', at: NOW },
      { kind: 'observed', paneKey: PANE, workspace: null, phase: 'rest', at: NOW }
    ])
  })

  it('stops observing once detached', () => {
    const h = createHarness()
    h.detector.attach(h.server)()
    ingest(h.server, { state: 'working' })
    expect(h.changes).toEqual([])
    expect(h.detector.hasHookRow(PANE)).toBe(false)
  })
})
