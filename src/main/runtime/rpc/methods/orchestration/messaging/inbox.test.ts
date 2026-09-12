import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { OrchestrationMailboxDeliveryTarget } from '../../../../orchestration/mailbox-delivery-target'
import { OrchestrationMailboxOwner } from '../../../../orchestration/mailbox-owner'
import { OrchestrationMailboxPointerDelivery } from '../../../../orchestration/mailbox-pointer-delivery'
import { WRITE_ACCEPTED } from '../../../../../../shared/pty-write-settlement'
import { formatMessagePointer } from '../../../../orchestration/formatter'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, ctx, activeRunId } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('orchestration.inbox', () => {
    it('returns all messages', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

      const result = (await call('orchestration.inbox', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('--terminal <handle> matches check --all output for the same handle', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const inbox = (await call('orchestration.inbox', { terminal: 'b' })) as {
        messages: { id: string; to_handle: string }[]
        count: number
      }
      const check = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { id: string; to_handle: string }[]; count: number }

      expect(inbox.count).toBe(2)
      expect(check.count).toBe(2)
      // Same rows in the same order — both use sequence DESC
      expect(inbox.messages.map((m) => m.id)).toEqual(check.messages.map((m) => m.id))
      expect(inbox.messages.every((m) => m.to_handle === 'b')).toBe(true)
    })

    it('--terminal <unknown_handle> returns empty list without erroring', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.inbox', {
        terminal: 'does_not_exist'
      })) as { count: number }
      expect(result.count).toBe(0)
    })

    it('with --terminal <coordinator_handle> returns messages sent to run:<run_id>', async () => {
      setup(true)
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Worker finished task',
        type: 'worker_done',
        payload: JSON.stringify({ outcome: 'succeeded' }),
        runId: activeRunId
      })
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Worker heartbeat',
        type: 'heartbeat',
        payload: JSON.stringify({ progress: 50 }),
        runId: activeRunId
      })
      db.insertMessage({ from: 'someone', to: 'term_other', subject: 'Unrelated message' })
      const inbox = (await call('orchestration.inbox', { terminal: 'term_coord' })) as {
        messages: { id: string; to_handle: string; type: string }[]
        count: number
      }
      expect(inbox.count).toBe(2)
      expect(inbox.messages.every((m) => m.to_handle === `run:${activeRunId}`)).toBe(true)
      expect(inbox.messages.map((m) => m.type)).toContain('worker_done')
      expect(inbox.messages.map((m) => m.type)).toContain('heartbeat')
    })

    it('with --terminal <worker_handle> returns messages sent to dispatch:<dispatch_id>', async () => {
      setup(true)
      const task = db.createTask({ spec: 'subtask', runId: activeRunId })
      const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'Task assigned',
        type: 'dispatch',
        runId: activeRunId
      })
      db.insertMessage({ from: 'someone', to: 'term_other', subject: 'Other' })
      const inbox = (await call('orchestration.inbox', { terminal: 'term_worker' })) as {
        messages: { id: string; to_handle: string }[]
        count: number
      }
      expect(inbox.count).toBe(1)
      expect(inbox.messages[0]?.to_handle).toBe(`dispatch:${dispatch.id}`)
    })

    it('push-on-idle pointer delivery resolves the coordinator terminal and delivers run:<run_id> messages when coordinator is live', async () => {
      vi.useFakeTimers()
      try {
        setup(true)
        const message = db.insertMessage({
          from: 'term_worker',
          to: `run:${activeRunId}`,
          subject: 'Worker done',
          type: 'worker_done',
          payload: JSON.stringify({ outcome: 'succeeded' }),
          runId: activeRunId
        })
        const [tabId = 'tab_coord', leafId = 'leaf_coord'] = coordinatorPaneKey.split(':')
        const leaf = {
          tabId,
          leafId,
          ptyId: 'pty_coord',
          writable: true,
          lastAgentStatus: 'idle' as const,
          lastAgentStatusObservedLive: true,
          lastOscTitle: null
        }
        const deliveryTarget = new OrchestrationMailboxDeliveryTarget({
          getDb: () => db,
          getTerminalHandleForPaneKey: (pk) => (pk === coordinatorPaneKey ? 'term_coord' : null),
          hasTerminalHandle: (h) => h === 'term_coord',
          isStructuredWorkerHandle: () => false,
          canProbePtyLiveness: () => true,
          controllerKnowsPtyIsLive: () => true,
          isLeafPtyProvenAbsent: async () => false
        })
        const mailboxOwner = new OrchestrationMailboxOwner({
          getDb: () => db,
          getLeaf: () => leaf,
          getLeafKey: (t, l) => `${t}:${l}`,
          getTerminalHandleForLeafKey: (lk) =>
            lk === coordinatorPaneKey ? 'term_coord' : undefined,
          getTerminalProcessIncarnation: () => 'inc_1',
          onRoutedMessageTypes: vi.fn(),
          onForeignMailboxRouted: vi.fn()
        })
        expect(deliveryTarget.resolveTerminalHandle(`run:${activeRunId}`)).toBe('term_coord')
        expect(mailboxOwner.resolve(leaf, `run:${activeRunId}`)).toBe(`run:${activeRunId}`)
        expect(mailboxOwner.resolve(leaf)).toBe(`run:${activeRunId}`)
        const writes: string[] = []
        const pointerDelivery = new OrchestrationMailboxPointerDelivery({
          deliveryTarget,
          mailboxOwner,
          getDb: () => db,
          getLeaf: () => leaf,
          getLiveLeafForHandle: () => leaf,
          getLeafKey: (t, l) => `${t}:${l}`,
          getTerminalHandleForLeafKey: (lk) =>
            lk === coordinatorPaneKey ? 'term_coord' : undefined,
          getMessageWaiters: () => undefined,
          getTabTitle: () => 'coordinator',
          getCliCommand: () => 'orca' as const,
          resolveSubmitTarget: () => ({
            leaf,
            terminalHandle: 'term_coord',
            processIncarnation: 'inc_1'
          }),
          isLeafPtyProvenAbsent: async () => false,
          redriveMailbox: vi.fn(),
          writePty: (_ptyId, data) => {
            writes.push(data)
            return WRITE_ACCEPTED
          }
        })
        pointerDelivery.deliverForHandle(`run:${activeRunId}`)
        await vi.advanceTimersByTimeAsync(1000)
        const delivered = db.getMessageById(message.id)
        expect(delivered?.delivered_at).not.toBeNull()
        expect(writes).toEqual([formatMessagePointer(1, `run:${activeRunId}`), '\r'])
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
