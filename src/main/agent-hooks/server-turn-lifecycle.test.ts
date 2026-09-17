import { describe, expect, it } from 'vitest'
import type { AgentTurnOwner } from '../../shared/agent-turn-lifecycle'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE = makePaneKey('tab-c2', '11111111-1111-4111-8111-111111111111')
const owner: AgentTurnOwner = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-c2',
  workspaceKind: 'folder',
  runId: 'run-c2',
  attachment: { executionId: 'execution-c2' },
  provider: 'codex'
}

function ingest(
  server: AgentHookServer,
  hookEventName: string,
  providerTurnId: string | undefined,
  payload: {
    state: 'working' | 'done'
    prompt?: string
    interrupted?: boolean
    toolAgentId?: string
  }
): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      source: 'codex',
      hookEventName,
      ...(providerTurnId ? { providerTurnId } : {}),
      ...(payload.toolAgentId ? { toolAgentId: payload.toolAgentId } : {}),
      payload: {
        state: payload.state,
        prompt: payload.prompt ?? 'ship it',
        agentType: 'codex',
        ...(payload.interrupted ? { interrupted: true } : {})
      }
    },
    'conn-c2'
  )
}

describe('AgentHookServer turn lifecycle integration', () => {
  it('reduces attributable provider completion and keeps a stable completion identity', () => {
    const server = new AgentHookServer()
    const changes: string[] = []
    server.registerAgentTurnOwner(PANE, owner)
    server.subscribeAgentTurnLifecycle(({ reduction }) => {
      changes.push(reduction.disposition)
    })

    ingest(server, 'UserPromptSubmit', 'turn-1', { state: 'working' })
    ingest(server, 'Stop', 'turn-1', { state: 'done' })
    ingest(server, 'Stop', 'turn-1', { state: 'done' })

    const snapshot = server.getAgentTurnLifecycleSnapshot(PANE)
    expect(snapshot?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-1', phase: 'settled', outcome: 'completed' })
    )
    expect(changes).toContain('duplicate')
  })

  it('remembers stale provider evidence so it does not replay indefinitely', () => {
    const server = new AgentHookServer()
    const dispositions: string[] = []
    server.registerAgentTurnOwner(PANE, owner)
    server.subscribeAgentTurnLifecycle(({ reduction }) => {
      dispositions.push(reduction.disposition)
    })

    ingest(server, 'Stop', 'orphan-turn', { state: 'done' })
    ingest(server, 'Stop', 'orphan-turn', { state: 'done' })

    expect(dispositions).toEqual(['ignored', 'duplicate'])
  })

  it('keeps an autonomous next turn separate from the prior unresolved turn', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)

    ingest(server, 'UserPromptSubmit', 'turn-first', { state: 'working' })
    ingest(server, 'UserPromptSubmit', 'turn-next', { state: 'working' })

    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.currentTurn).toMatchObject({
      turnId: 'turn-next',
      phase: 'active'
    })
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-first', phase: 'unresolved', outcome: null })
    )
  })

  it('records interrupt request and input without settling until provider acknowledgement', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-2', { state: 'working' })
    const row = server.getStatusSnapshotForPane(PANE)[0]
    if (!row) {
      throw new Error('expected working status row')
    }

    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: row.receivedAt,
        baselineStateStartedAt: row.stateStartedAt,
        baselinePrompt: 'ship it',
        baselineAgentType: 'codex',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('working')
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.currentTurn).toMatchObject({
      phase: 'active',
      interrupt: 'requested',
      interruptInputWrittenAt: expect.any(Number)
    })

    ingest(server, 'StopCancelled', 'turn-2', { state: 'done', interrupted: true })
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-2', phase: 'settled', outcome: 'interrupted' })
    )
  })

  it('recovers a matching terminal record but refuses another run attachment', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: owner.runId,
          executionId: owner.attachment.executionId,
          turnId: 'turn-record',
          outcome: 'completed'
        },
        observedAt: 20
      })?.disposition
    ).toBe('accepted')
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-record', outcome: 'completed' })
    )

    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: 'run-other',
          executionId: owner.attachment.executionId,
          turnId: 'turn-other',
          outcome: 'completed'
        }
      })
    ).toBeNull()
  })

  it('marks an active turn unresolved on certified exit and ignores late provider delivery', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-exit', { state: 'working' })
    expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)
    expect(server.getAgentTurnLifecycleSnapshot(PANE)).toMatchObject({ executionVerdict: 'exited' })
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-exit', phase: 'unresolved', outcome: null })
    )

    ingest(server, 'Stop', 'turn-exit', { state: 'done' })
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-exit', phase: 'unresolved', outcome: null })
    )
    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: owner.runId,
          executionId: owner.attachment.executionId,
          turnId: 'late-turn',
          outcome: 'completed'
        }
      })
    ).toBeNull()
  })

  it('observes certified exit even when the legacy status row was dismissed', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-dismissed', { state: 'working' })
    server.clearPaneState(PANE)

    expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(0)
    expect(server.getAgentTurnLifecycleSnapshot(PANE)).toMatchObject({
      executionVerdict: 'exited'
    })
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-dismissed', phase: 'unresolved' })
    )
  })

  it('does not bind anonymous child hooks to whichever root turn is current', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-child', { state: 'working' })
    ingest(server, 'SubagentStart', undefined, {
      state: 'working',
      toolAgentId: 'child-1'
    })
    ingest(server, 'Stop', undefined, {
      state: 'done',
      toolAgentId: 'child-1'
    })
    const snapshot = server.getAgentTurnLifecycleSnapshot(PANE)
    expect(snapshot?.currentTurn).toMatchObject({ phase: 'active', turnId: 'turn-child' })
    expect(snapshot?.joinedChildren).toEqual([])
  })

  it('does not rebind delayed anonymous child evidence to a later root turn', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-first', { state: 'working' })
    ingest(server, 'UserPromptSubmit', 'turn-next', { state: 'working' })
    ingest(server, 'Stop', undefined, { state: 'done', toolAgentId: 'child-1' })

    const snapshot = server.getAgentTurnLifecycleSnapshot(PANE)
    expect(snapshot?.currentTurn).toMatchObject({ phase: 'active', turnId: 'turn-next' })
    expect(snapshot?.joinedChildren).toEqual([])
  })

  it('reconciles a complete remote inventory instead of treating a missing field as empty', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-inventory', { state: 'working' })

    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        hookEventName: 'SessionIdle',
        providerTurnInventoryComplete: true,
        providerTurnInventory: null,
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      },
      'conn-c2'
    )

    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.currentTurnId).toBeNull()
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-inventory', phase: 'unresolved', outcome: null })
    )
  })

  it('bounds recovery custody and still accepts a later attributable terminal record', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-recovery', { state: 'working' })

    expect(server.startAgentTurnRecovery(PANE, 'custody-1', 100, 10)?.disposition).toBe('accepted')
    expect(server.expireAgentTurnRecovery(PANE, 'turn-recovery', 'custody-1', 99)?.reason).toBe(
      'stale'
    )
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.currentTurn).toMatchObject({
      phase: 'recovering'
    })
    expect(
      server.expireAgentTurnRecovery(PANE, 'turn-recovery', 'custody-1', 100)?.disposition
    ).toBe('accepted')
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.currentTurnId).toBeNull()
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-recovery', phase: 'unresolved', outcome: null })
    )

    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: owner.runId,
          executionId: owner.attachment.executionId,
          turnId: 'turn-recovery',
          outcome: 'completed'
        },
        observedAt: 101
      })?.disposition
    ).toBe('accepted')
    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: owner.runId,
          executionId: owner.attachment.executionId,
          turnId: 'turn-recovery',
          outcome: 'completed'
        },
        observedAt: 102
      })?.disposition
    ).toBe('duplicate')
  })

  it('abandons recovery without allowing a late terminal record to fabricate success', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'turn-abandon', { state: 'working' })
    expect(server.startAgentTurnRecovery(PANE, 'custody-2', 200, 20)?.disposition).toBe('accepted')
    expect(
      server.abandonAgentTurnRecovery(PANE, 'turn-abandon', 'custody-2', 21)?.disposition
    ).toBe('accepted')
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toContainEqual(
      expect.objectContaining({ turnId: 'turn-abandon', phase: 'abandoned', outcome: null })
    )
    expect(
      server.ingestProviderTerminalTurnRecord(PANE, {
        record: {
          runId: owner.runId,
          executionId: owner.attachment.executionId,
          turnId: 'turn-abandon',
          outcome: 'completed'
        },
        observedAt: 22
      })?.reason
    ).toBe('conflict')
  })

  it('replaces the lifecycle state when a pane receives a new committed owner', () => {
    const server = new AgentHookServer()
    server.registerAgentTurnOwner(PANE, owner)
    ingest(server, 'UserPromptSubmit', 'old-turn', { state: 'working' })
    const replacement: AgentTurnOwner = {
      ...owner,
      runId: 'run-replacement',
      attachment: { executionId: 'execution-replacement' }
    }
    expect(server.registerAgentTurnOwner(PANE, replacement)).toBe(true)
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.turns).toHaveLength(0)
    expect(server.unregisterAgentTurnOwner(PANE, owner)).toBe(false)
    expect(server.getAgentTurnLifecycleSnapshot(PANE)?.owner.runId).toBe('run-replacement')
    expect(server.unregisterAgentTurnOwner(PANE, replacement)).toBe(true)
  })
})
