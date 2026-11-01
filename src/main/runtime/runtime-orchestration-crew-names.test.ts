import { expect, it, vi } from 'vitest'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'

type NamingDeps = ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]
type Session = NonNullable<ReturnType<NamingDeps['getWorkspaceSession']>>

it('captures actual raw naming reads once at N/10N and preserves naming precedence across consumers', () => {
  for (const population of [3, 30]) {
    const handles = Array.from({ length: population }, (_, i) => `term_${i}`)
    const session: Session = {
      tabsByWorktree: {
        workspace: handles.map((handle) => ({
          id: `tab_${handle}`,
          title: `Generated ${handle}`,
          customTitle: `Named ${handle}`
        }))
      }
    }
    const deps: NamingDeps = {
      getDb: vi.fn(() => null),
      getWorkspaceSession: vi.fn(() => session),
      getGeneratedTitlesEnabled: vi.fn(() => true),
      getHandleRecord: vi.fn((handle) => ({
        worktreeId: 'workspace',
        tabId: `tab_${handle}`,
        ptyId: handle
      })),
      getPtyAgents: vi.fn(() => ({ launchAgent: 'codex' })),
      getTerminalPaneKey: vi.fn((handle) => `tab_${handle}:leaf`),
      getAgentStatusSnapshot: vi.fn(() =>
        handles.map((handle) => ({
          paneKey: `tab_${handle}:leaf`,
          worktreeId: 'workspace',
          agentType: 'codex' as const,
          receivedAt: 1,
          connectionId: null
        }))
      ),
      getAgentStatusSnapshotForPane: vi.fn(() => []),
      getTrackedTitle: vi.fn(() => null)
    }
    const names = new RuntimeOrchestrationSenderNames(deps)
    const parties = handles.map((handle) => ({
      address: handle,
      terminalHandle: handle,
      orcaSessionId: null
    }))
    const expected = parties.map((party) => names.nameOf(party, undefined, 'Task', null))
    for (const read of Object.values(deps)) {
      vi.mocked(read).mockClear()
    }
    const captured = names.captureCrewInputs()
    for (let consumer = 0; consumer < population; consumer++) {
      expect(parties.map((party) => captured(party, 'Task', null))).toEqual(expected)
    }
    expect(deps.getWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(deps.getAgentStatusSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.getAgentStatusSnapshotForPane).not.toHaveBeenCalled()
    for (const read of [
      deps.getHandleRecord,
      deps.getPtyAgents,
      deps.getTerminalPaneKey,
      deps.getTrackedTitle
    ]) {
      expect(read).toHaveBeenCalledTimes(population)
    }
    const capturedPane = vi.fn((handle: string) => `tab_${handle}:leaf`)
    vi.mocked(deps.getTerminalPaneKey).mockClear()
    const scoped = names.captureCrewInputs()
    expect(parties.map((party) => scoped(party, 'Task', null, capturedPane))).toEqual(expected)
    expect(capturedPane).toHaveBeenCalledTimes(population)
    expect(deps.getTerminalPaneKey).not.toHaveBeenCalled()
    session.tabsByWorktree = { workspace: [{ id: 'tab_term_0', customTitle: 'Changed' }] }
    expect(captured(parties[0], 'Task', null)).toBe(expected[0])
    expect(names.captureCrewInputs()(parties[0], 'Task', null)).toBe('Changed')
  }
})
