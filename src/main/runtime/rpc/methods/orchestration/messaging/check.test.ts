import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcContext } from '../../../core'

import { createOrchestrationRpcHarness } from '../rpc-test-harness'

import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

import '../../../../orchestration/workers/lifecycle/lifecycle-reconciliation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

import '../../../../orchestration/db/root-dispatch-test-fixture'
import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  // A consuming check now requires a live pane, so direct-mailbox handles must resolve to one.
  function resolveDirectPanes(...handles: string[]): void {
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handles.includes(handle)
          ? `tab_${handle}:leaf_${handle}`
          : null
    )
  }

  describe('orchestration.check', () => {
    it('never mixes two bound Run mailboxes', async () => {
      setup(false)
      const paneA = 'tab_a:11111111-1111-4111-8111-111111111111'
      const paneB = 'tab_b:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_a' ? paneA : paneB
      )
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term_a',
        coordinatorPaneKey: paneA
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term_b',
        coordinatorPaneKey: paneB
      })
      db.insertMessage({
        from: 'worker_a',
        to: `run:${runA.id}`,
        subject: 'A only',
        runId: runA.id
      })
      db.insertMessage({
        from: 'worker_b',
        to: `run:${runB.id}`,
        subject: 'B only',
        runId: runB.id
      })

      const inboxA = (await call('orchestration.check', { terminal: 'term_a' })) as {
        messages: { subject: string }[]
      }
      const inboxB = (await call('orchestration.check', { terminal: 'term_b' })) as {
        messages: { subject: string }[]
      }
      expect(inboxA.messages.map((message) => message.subject)).toEqual(['A only'])
      expect(inboxB.messages.map((message) => message.subject)).toEqual(['B only'])
    })

    it('uses the stable pane identity when the coordinator handle was reminted', async () => {
      setup()
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Completed after restart',
        runId: activeRunId
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_stale_coord',
        terminalPaneKey: coordinatorPaneKey
      })) as { runId: string; messages: { subject: string }[] }

      expect(result).toMatchObject({
        runId: activeRunId,
        messages: [{ subject: 'Completed after restart' }]
      })
    })

    it('keeps a live handle authoritative over mismatched pane metadata', async () => {
      setup()
      const foreignRun = db.createRun({
        objective: 'Foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Coordinator only',
        runId: activeRunId
      })
      db.insertMessage({
        from: 'term_foreign_worker',
        to: `run:${foreignRun.id}`,
        subject: 'Foreign only',
        runId: foreignRun.id
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        terminalPaneKey: 'tab_foreign:leaf_foreign',
        all: true
      })) as { runId: string; messages: { subject: string }[] }

      expect(result.runId).toBe(activeRunId)
      expect(result.messages.map((message) => message.subject)).toEqual(['Coordinator only'])
    })

    it('says to check again only when a capped batch leaves mail behind', async () => {
      setup()
      for (let index = 0; index < 51; index++) {
        db.insertMessage({
          from: 'term_worker',
          to: `run:${activeRunId}`,
          subject: `status ${index}`,
          type: 'status',
          runId: activeRunId
        })
      }
      const check = () => call('orchestration.check', { terminal: 'term_coord' })

      expect(await check()).toMatchObject({ count: 50, next: expect.stringContaining('again') })
      const last = await check()
      expect(last).toMatchObject({ count: 1 })
      expect(last).not.toHaveProperty('next')
    })

    it('rejects stale Delivery acknowledgment without consuming queued mail', async () => {
      setup()
      db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'queued',
        runId: activeRunId
      })

      await expect(
        call('orchestration.check', {
          terminal: 'term_coord',
          ack: 'delivery_missing'
        })
      ).rejects.toMatchObject({ code: 'stale_delivery' })
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(1)
    })

    it('acknowledges a Run Delivery before returning --peek history', async () => {
      setup()
      db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'queued',
        runId: activeRunId
      })

      const first = (await call('orchestration.check', {
        terminal: 'term_coord'
      })) as { count: number; deliveryId: string }
      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        ack: first.deliveryId,
        peek: true
      })) as { acknowledged: string | null; count: number }

      expect(first.count).toBe(1)
      expect(peeked).toMatchObject({ acknowledged: first.deliveryId, count: 0 })
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(0)
    })

    it('peeks an old unread Run row beyond the newest history page', async () => {
      setup()
      const unread = db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'old unread',
        runId: activeRunId
      })
      for (let index = 0; index < 100; index += 1) {
        const read = db.insertMessage({
          from: 'worker',
          to: `run:${activeRunId}`,
          subject: `new read ${index}`,
          runId: activeRunId
        })
        db.markAsRead([read.id])
      }

      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        peek: true
      })) as { messages: { id: string }[]; count: number }
      const delivered = (await call('orchestration.check', {
        terminal: 'term_coord'
      })) as { messages: { id: string }[]; count: number }

      expect(peeked).toMatchObject({ count: 1, messages: [{ id: unread.id }] })
      expect(delivered).toMatchObject({ count: 1, messages: [{ id: unread.id }] })
    })

    it('waits for a filtered Run peek without consuming the arrival', async () => {
      setup()
      let arrivedId = ''
      const waitSpy = vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        arrivedId = db.insertMessage({
          from: 'worker',
          to: `run:${activeRunId}`,
          subject: 'peeked completion',
          type: 'worker_done',
          runId: activeRunId
        }).id
        return new MessageWake()
      })

      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        peek: true,
        wait: true,
        types: 'worker_done',
        timeoutMs: 100
      })) as { messages: { id: string }[]; count: number }

      expect(peeked).toMatchObject({ count: 1, messages: [{ id: arrivedId }] })
      expect(waitSpy).toHaveBeenCalledWith(
        `run:${activeRunId}`,
        expect.objectContaining({ typeFilter: ['worker_done'] })
      )
      expect(db.getMessageById(arrivedId)?.read).toBe(0)
      expect(db.getUnreadMessages(`run:${activeRunId}`, ['worker_done'])).toHaveLength(1)
    })

    it('default (unread only) marks returned rows as read', async () => {
      setup()
      resolveDirectPanes('b')
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })

      const first = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(first.count).toBe(2)

      const second = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(second.count).toBe(0)
    })

    it('rejects a consuming check whose --terminal no longer resolves to a pane', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'term_gone', subject: 'stranded' })

      await expect(call('orchestration.check', { terminal: 'term_gone' })).rejects.toMatchObject({
        code: 'stable_pane_required',
        data: { effectsApplied: false }
      })
      // The stranded row must survive the refusal so a rebound consumer can still read it.
      expect(db.getUnreadMessages('term_gone')).toHaveLength(1)
    })

    it('still inspects a stale handle with --peek and --all', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'term_gone', subject: 'stranded' })

      const peeked = (await call('orchestration.check', {
        terminal: 'term_gone',
        peek: true
      })) as { count: number }
      const history = (await call('orchestration.check', {
        terminal: 'term_gone',
        all: true
      })) as { count: number }

      expect(peeked.count).toBe(1)
      expect(history.count).toBe(1)
    })

    it('--peek returns unread messages without marking them read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it("treats the CLI's {peek, unread:false} compat pair as peek, not all", async () => {
      setup()
      const seen = db.insertMessage({ from: 'a', to: 'b', subject: 'seen' })
      db.markAsRead([seen.id])
      db.insertMessage({ from: 'a', to: 'b', subject: 'fresh' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true,
        unread: false
      })) as { messages: { subject: string }[]; count: number }

      expect(result.count).toBe(1)
      expect(result.messages[0]?.subject).toBe('fresh')
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('--all returns every message for the handle without marking read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      const second = db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.markAsRead([second.id])

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { read: number }[]; count: number }

      expect(result.count).toBe(2)
      const stillUnread = db.getUnreadMessages('b')
      expect(stillUnread).toHaveLength(1)
    })

    it('--all applies type filters without marking rows as read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'dispatch', type: 'dispatch' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true,
        types: 'worker_done,dispatch'
      })) as { messages: { type: string }[]; count: number }

      expect(result.count).toBe(2)
      expect(result.messages.map((m) => m.type).sort()).toEqual(['dispatch', 'worker_done'])
      expect(db.getUnreadMessages('b')).toHaveLength(3)
    })

    it('does not mark messages read when a waiting check is aborted', async () => {
      setup()
      resolveDirectPanes('b')
      const abortController = new AbortController()
      ctx = { runtime, signal: abortController.signal }
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        db.insertMessage({ from: 'a', to: 'b', subject: 'arrived during close' })
        abortController.abort()
        return 'cancelled'
      })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('keeps waiting for requested types when an unrelated status arrives', async () => {
      setup()
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'coord' ? 'tab_wait:leaf_wait' : null
      )

      const waitPromise = call('orchestration.check', {
        terminal: 'coord',
        wait: true,
        timeoutMs: 5000,
        types: 'escalation,question'
      }) as Promise<{ count: number; messages: { type: string }[] }>
      await Promise.resolve()

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'still working',
        type: 'status',
        run: activeRunId
      })

      const early = await Promise.race([
        waitPromise.then(() => 'settled'),
        Promise.resolve('pending')
      ])
      expect(early).toBe('pending')

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'needs attention',
        type: 'question',
        run: activeRunId
      })

      const result = await waitPromise
      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('question')
    })

    it('does not mark existing messages read when the check starts aborted', async () => {
      setup()
      resolveDirectPanes('b')
      const abortController = new AbortController()
      abortController.abort()
      ctx = { runtime, signal: abortController.signal }
      db.insertMessage({ from: 'a', to: 'b', subject: 'already unread' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })
  })
})
