import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const h = createOrchestrationRpcHarness()
const { coordinatorPaneKey } = h
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let ctx: RpcContext

function setup(withBoundRun = true): void {
  ;({ db, runtime, ctx } = h.setup(withBoundRun))
}

afterEach(() => {
  h.cleanup()
})

function resolveDirectPanes(...handles: string[]): void {
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord'
      ? coordinatorPaneKey
      : handles.includes(handle)
        ? `tab_${handle}:leaf_${handle}`
        : null
  )
}

function createDispatchedTask(assigneeHandle: string, assigneePaneKey: string) {
  const task = db.createTask({ spec: 'manual check work' })
  return { task, dispatch: createRootDispatch(db, task.id, assigneeHandle, assigneePaneKey) }
}

describe("orchestration.check of another live terminal's mailbox", () => {
  const asCaller = (evidence?: { terminalHandle?: string; paneKey?: string }) => ({
    ...ctx,
    orchestrationCompatibilityEvidence: evidence
  })

  it('is not consumed by the caller, who may still peek; its own terminal consumes it', async () => {
    setup()
    resolveDirectPanes('term_b')
    db.insertMessage({ from: 'term_coord', to: 'term_b', subject: 'for b' })
    const coordinator = asCaller({ terminalHandle: 'term_coord' })

    await expect(
      h.call('orchestration.check', { terminal: 'term_b' }, coordinator)
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    await expect(
      h.call('orchestration.check', { terminal: 'term_b', peek: true }, coordinator)
    ).resolves.toMatchObject({ count: 1 })
    await expect(
      h.call('orchestration.check', { terminal: 'term_b' }, asCaller({ terminalHandle: 'term_b' }))
    ).resolves.toMatchObject({ count: 1 })
  })

  it.each([{ peek: true }, { all: true }, { unread: false }])(
    "is not acknowledged by the caller in read mode %j; the worker's own peek can",
    async (mode) => {
      setup()
      resolveDirectPanes('term_b')
      const { dispatch } = createDispatchedTask('term_b', 'tab_term_b:leaf_term_b')
      const message = db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'must reach b'
      })
      const worker = asCaller({ terminalHandle: 'term_b' })
      const opened = await h.call('orchestration.check', { terminal: 'term_b' }, worker)
      const deliveryId = z.object({ deliveryId: z.string() }).parse(opened).deliveryId

      await expect(
        h.call(
          'orchestration.check',
          { terminal: 'term_b', ack: deliveryId, ...mode },
          asCaller({ terminalHandle: 'term_coord' })
        )
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getMessageById(message.id)?.read).toBe(0)
      await expect(
        h.call('orchestration.check', { terminal: 'term_b', ack: deliveryId, peek: true }, worker)
      ).resolves.toMatchObject({ acknowledged: deliveryId })
    }
  )

  it('is not consumed by a different terminal process that shares its recorded pane', async () => {
    setup(false)
    vi.mocked(runtime.getTerminalPaneKey).mockRestore()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockRestore()
    const pane = { tabId: 'tab-shared', leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const a = runtime.preAllocateHandleForPty('pty-a')
    const b = runtime.preAllocateHandleForPty('pty-b')
    runtime.registerPty('pty-a', 'workspace', null, { ...pane, incarnationId: 'a' })
    runtime.registerPty('pty-b', 'workspace', null, { ...pane, incarnationId: 'b' })
    db.insertMessage({ from: 'sender', to: b, subject: 'for b' })

    await expect(
      h.call('orchestration.check', { terminal: b }, asCaller({ terminalHandle: a }))
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  // Unproven or exited identities keep the old behaviour: these name no live terminal to compare.
  it.each([
    ['no evidence', undefined, 'term_b'],
    ['an unknown pane only', { paneKey: 'tab_x:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'term_b'],
    ['an exited own handle', { terminalHandle: 'term_gone' }, 'term_b'],
    [
      'an exited own handle whose pane now holds another terminal',
      { terminalHandle: 'term_gone', paneKey: 'tab_term_gone:leaf_term_gone' },
      'term_b'
    ],
    ['an exited mailbox', { terminalHandle: 'term_coord' }, 'term_gone']
  ])('is consumed as before with %s', async (_name, evidence, mailbox) => {
    setup()
    resolveDirectPanes('term_b')
    vi.mocked(runtime.getLiveTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_gone' ? null : runtime.getTerminalPaneKey(handle)
    )
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_b' || handle === 'term_gone'
          ? `tab_${handle}:leaf_${handle}`
          : handle === 'term_c'
            ? 'tab_term_gone:leaf_term_gone'
            : null
    )
    // term_gone exited, and term_c has since started in its pane.
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockImplementation((handle) =>
      handle === 'term_gone' ? { status: 'exited' } : null
    )
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === 'tab_term_gone:leaf_term_gone' ? 'term_c' : null
    )
    db.insertMessage({ from: 'sender', to: mailbox, subject: 'leftover' })

    await expect(
      h.call('orchestration.check', { terminal: mailbox }, asCaller(evidence))
    ).resolves.toMatchObject({ count: 1 })
  })
})
