// One structured Codex session driven end to end over `agentSession.*`.
//
// Nothing here is stubbed except the Codex child itself: the RPC dispatcher, the
// zod schemas, the capability gate, the durable record store, the journal, the
// lease, the Codex adapter, and the event-to-journal translation are all the ones
// that ship. The fake app-server answers the same JSON-RPC calls the real one
// does and pushes the same notifications and blocking requests back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { journalDirectoryFor } from '../native-chat/agent-session-journal/journal-paths'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  THREAD,
  TURN,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

const journals = createTrackedJournalOpener()
const WORKSPACE = 'workspace-1'

let harness: StructuredCodexRpcHarness

function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

beforeEach(async () => {
  harness = await openStructuredCodexRpcHarness()
})

afterEach(async () => {
  await journals.closeAll()
  await harness.dispose()
})

describe('a structured codex session over agentSession.*', () => {
  it('replays a durable image send without dispatching it twice', async () => {
    const created = await harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    const path = '/tmp/orca-paste-image.png'
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'image-ref' as const, path }]
    }
    const params = {
      envelope: harness.envelope('agentSession.send', { body }, created.fence),
      body
    }

    const turnStarts = () =>
      harness.codex.live().calls.filter((entry) => entry.method === 'turn/start')
    await harness.ok('agentSession.send', params)
    // Accepted first; the delivery loop hands it over once.
    await vi.waitFor(() => expect(turnStarts()).toHaveLength(1))
    const replay = await harness.call('agentSession.send', params)

    expect(replay).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
    expect(turnStarts()).toHaveLength(1)
  })

  it('joins an acquired attach through journal bind before draining final rows', async () => {
    const host = await ensureStructuredAgentSessionHost(harness.hostConfig())
    const adapter = (host as unknown as { deps: { adapter: CodexStructuredSessionAdapter } }).deps
      .adapter
    const historyEntered = Promise.withResolvers<void>()
    const historyGate = Promise.withResolvers<void>()
    const originalHistoryFilePath = adapter.historyFilePath.bind(adapter)
    vi.spyOn(adapter, 'historyFilePath').mockImplementation(async (input) => {
      historyEntered.resolve()
      await historyGate.promise
      return originalHistoryFilePath(input)
    })

    const creating = harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    await historyEntered.promise
    harness.codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    harness.codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'item-bind-window', text: '' }
    })
    harness.codex.notify('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-bind-window',
      delta: 'Buffered while the journal opens.'
    })

    let stopped = false
    const stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const waitedForJournalBind = !stopped
    historyGate.resolve()
    await creating
    await stopping
    expect(waitedForJournalBind).toBe(true)

    const identity = {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
    const reopened = await journals.open({
      identity,
      journalDir: journalDirectoryFor(harness.root, identity)
    })
    expect(reopened.snapshot().items.map(textOf)).toContain('Buffered while the journal opens.')
    expect(
      reopened
        .snapshot()
        .items.some(
          (item) => item.body?.kind === 'status' && item.body.turnLifecycle?.state === 'running'
        )
    ).toBe(false)
  })
})
