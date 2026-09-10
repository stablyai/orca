import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

const baseIntent = {
  mutationId: 'close-1',
  executionHostId: 'local',
  workspaceKey: 'folder:workspace-1',
  terminalHandle: 'term-1',
  targetKind: 'terminal' as const,
  ptyIncarnation: 'pty-1:inc-1',
  processRootId: 'pty-1',
  ownerPrincipal: 'device-1',
  reason: 'user-close'
}

describe('terminal close intent store', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('replays the durable intent for the exact mutation and process identity', () => {
    db = new OrchestrationDb(':memory:')
    const first = db.reserveTerminalCloseIntent(baseIntent)
    const replay = db.reserveTerminalCloseIntent(baseIntent)

    expect(replay).toEqual(first)
    expect(db.getTerminalCloseIntent(first.mutationId)).toEqual(first)
  })

  it('rejects mutation reuse with another terminal incarnation', () => {
    db = new OrchestrationDb(':memory:')
    db.reserveTerminalCloseIntent(baseIntent)

    expect(() =>
      db?.reserveTerminalCloseIntent({ ...baseIntent, ptyIncarnation: 'pty-1:inc-2' })
    ).toThrow('already bound to another identity')
  })

  it('routes worker-owned terminals to worker release authority', () => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
          id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation
        ) VALUES ('resource-1', 'dispatch-1', 'dispatch-1', 'term-1', 'pty-1:inc-1')`
      )
      .run()

    expect(() => db?.reserveTerminalCloseIntent(baseIntent)).toThrow('worker release authority')
    expect(db.getTerminalCloseIntent(baseIntent.mutationId)).toBeUndefined()
  })

  it('routes coordinator terminals to coordinator lease authority', () => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO maestro_terminal_leases (
          id, request_id, execution_host_id, workspace_key, terminal_handle, pty_incarnation,
          process_root_id, run_id, coordinator_generation, role, title, launch_profile_json,
          spawned_by, owner_principal, retention_policy, lifecycle_state
        ) VALUES (
          'lease-1', 'request-1', 'local', 'folder:workspace-1', 'term-1', 'pty-1:inc-1',
          'pty-1', 'run-1', 1, 'coordinator', 'Coordinator', '{}', 'user', 'owner',
          'retain', 'active'
        )`
      )
      .run()

    expect(() => db?.reserveTerminalCloseIntent(baseIntent)).toThrow('coordinator-lease')
    expect(db.getTerminalCloseIntent(baseIntent.mutationId)).toBeUndefined()
  })
})
