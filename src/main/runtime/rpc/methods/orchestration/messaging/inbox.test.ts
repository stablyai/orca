import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('orchestration.inbox', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>

  beforeEach(() => {
    state = h.setup()
  })

  afterEach(() => {
    h.cleanup()
  })

  async function inbox(params: Record<string, unknown>): Promise<unknown> {
    return h.call('orchestration.inbox', params, state.ctx)
  }

  it('returns all messages', async () => {
    state.db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
    state.db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    expect(((await inbox({})) as { count: number }).count).toBe(2)
  })

  it('--terminal <handle> matches check --all output for the same handle', async () => {
    state.db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
    state.db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
    state.db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const inboxResult = (await inbox({ terminal: 'b' })) as {
      messages: { id: string; to_handle: string }[]
      count: number
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const checkResult = (await h.call(
      'orchestration.check',
      { terminal: 'b', all: true },
      state.ctx
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
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'Run-wide mail',
      runId: state.activeRunId
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
      runBinding: state.activeRunId
    })
  })

  it('reads a Run mailbox only for its current consumer', async () => {
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'Run-wide mail',
      runId: state.activeRunId
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    const result = (await inbox({ terminal: 'term_coord', run: state.activeRunId })) as {
      messages: { subject: string }[]
      count: number
      scope: string
      runBinding: string | null
    }

    expect(result).toMatchObject({
      count: 1,
      messages: [{ subject: 'Run-wide mail' }],
      scope: `messages addressed to Run ${state.activeRunId}`,
      runBinding: state.activeRunId
    })
  })

  it('rejects a Run-scoped read when a live terminal binding disagrees with a supplied pane', async () => {
    state = h.setup(false)
    const paneA = 'tab_a:11111111-1111-4111-8111-111111111111'
    const paneB = 'tab_b:22222222-2222-4222-9222-222222222222'
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_a' ? paneA : handle === 'term_b' ? paneB : null
    )
    state.db.createRun({
      objective: 'Run A',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: paneA
    })
    const runB = state.db.createRun({
      objective: 'Run B',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: paneB
    })

    await expect(
      inbox({ terminal: 'term_a', terminalPaneKey: paneB, run: runB.id })
    ).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('--terminal <unknown_handle> returns an empty list without erroring', async () => {
    state.db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC harness parses this method's schema before returning its fixed receipt shape.
    expect(((await inbox({ terminal: 'does_not_exist' })) as { count: number }).count).toBe(0)
  })
})
