import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../../../shared/runtime-types'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

// The same delivery plumbing `check` already strips; a send/reply receipt is the same mailbox row.
const INTERNAL_COLUMNS = [
  'read',
  'sequence',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation'
]

function terminalSummary(handle: string): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: `pty_${handle}`,
    worktreeId: 'wt_default',
    worktreePath: '/tmp/wt',
    branch: 'main',
    tabId: 'tab_1',
    leafId: handle,
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

describe('orchestration send and reply receipts', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  afterEach(() => h.cleanup())

  function setup(): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup())
  }

  it('keeps delivery plumbing out of a point-to-point send receipt', async () => {
    setup()

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `run:${activeRunId}`, subject: 'plumbing' },
      ctx
    )) as { message: Record<string, unknown> }

    expect(result.message).toMatchObject({ subject: 'plumbing' })
    for (const column of INTERNAL_COLUMNS) {
      expect(result.message).not.toHaveProperty(column)
    }
  })

  it('keeps delivery plumbing out of a group send receipt', async () => {
    setup()
    const terminals = [terminalSummary('term_a'), terminalSummary('term_b')]
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals,
      totalCount: terminals.length,
      truncated: false
    })
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => {
      const terminal = terminals.find((candidate) => candidate.handle === handle)
      return terminal ? `${terminal.tabId}:${terminal.leafId}` : null
    })

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_a', to: '@all', subject: 'group plumbing' },
      ctx
    )) as { messages: Record<string, unknown>[] }

    expect(result.messages).toHaveLength(1)
    for (const message of result.messages) {
      for (const column of INTERNAL_COLUMNS) {
        expect(message).not.toHaveProperty(column)
      }
    }
  })

  it('keeps delivery plumbing out of a reply receipt', async () => {
    setup()
    const original = db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'Need an answer'
    })

    const result = (await h.call(
      'orchestration.reply',
      { id: original.id, body: 'One durable answer', from: 'term_coord' },
      ctx
    )) as { message: Record<string, unknown> }

    expect(result.message).toMatchObject({ subject: 'Re: Need an answer' })
    for (const column of INTERNAL_COLUMNS) {
      expect(result.message).not.toHaveProperty(column)
    }
  })
})
