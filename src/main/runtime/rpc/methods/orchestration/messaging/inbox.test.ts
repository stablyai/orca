import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

describe('orchestration.inbox', () => {
  const h = createOrchestrationRpcHarness()
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

  async function inbox(params: Record<string, unknown>): Promise<unknown> {
    return h.call('orchestration.inbox', params, ctx)
  }

  it('returns all messages', async () => {
    setup()
    db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
    db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    expect(((await inbox({})) as { count: number }).count).toBe(2)
  })

  it('--terminal <handle> matches check --all output for the same handle', async () => {
    setup()
    db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
    db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
    db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const inboxResult = (await inbox({ terminal: 'b' })) as {
      messages: { id: string; to_handle: string }[]
      count: number
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const checkResult = (await h.call(
      'orchestration.check',
      { terminal: 'b', all: true },
      ctx
    )) as {
      messages: { id: string; to_handle: string }[]
      count: number
    }

    expect(inboxResult.count).toBe(2)
    expect(checkResult.count).toBe(2)
    expect(inboxResult.messages.map((message) => message.id)).toEqual(
      checkResult.messages.map((message) => message.id)
    )
    expect(inboxResult.messages.every((message) => message.to_handle === 'b')).toBe(true)
  })

  it('declares a terminal recipient scope and its current Run binding', async () => {
    setup()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'Run-wide mail',
      runId: activeRunId
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const result = (await inbox({ terminal: 'term_coord' })) as {
      count: number
      scope: string
      runBinding: string | null
    }

    expect(result).toMatchObject({
      count: 0,
      scope: 'messages addressed to terminal term_coord',
      runBinding: activeRunId
    })
  })

  it('reads a Run mailbox only for its current consumer', async () => {
    setup()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'Run-wide mail',
      runId: activeRunId
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const result = (await inbox({ terminal: 'term_coord', run: activeRunId })) as {
      messages: { subject: string }[]
      count: number
      scope: string
      runBinding: string | null
    }

    expect(result).toMatchObject({
      count: 1,
      messages: [{ subject: 'Run-wide mail' }],
      scope: `messages addressed to Run ${activeRunId}`,
      runBinding: activeRunId
    })
  })

  it('rejects a Run-scoped read when a live terminal binding disagrees with a supplied pane', async () => {
    setup(false)
    const paneA = 'tab_a:11111111-1111-4111-8111-111111111111'
    const paneB = 'tab_b:22222222-2222-4222-9222-222222222222'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_a' ? paneA : handle === 'term_b' ? paneB : null
    )
    const runA = db.createRun({
      objective: 'Run A',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: paneA
    })
    const runB = db.createRun({
      objective: 'Run B',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: paneB
    })

    await expect(
      inbox({ terminal: 'term_a', terminalPaneKey: paneB, run: runB.id })
    ).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: `This coordinator terminal is bound to ${runA.id}, not ${runB.id}.`
    })
  })

  it('--terminal <unknown_handle> returns an empty list without erroring', async () => {
    setup()
    db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    expect(((await inbox({ terminal: 'does_not_exist' })) as { count: number }).count).toBe(0)
  })
})
