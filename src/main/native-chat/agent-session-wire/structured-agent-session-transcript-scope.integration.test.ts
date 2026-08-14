import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAcquireInput } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'

it('keeps child speech out of history, live batches, reopen and cursor replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-scope-'))
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const acquire = vi.fn(async ({ fence, spawnToken }: StructuredAgentSessionAcquireInput) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: 'primary',
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: 'created' as const,
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  const host = new StructuredAgentSessionHost({
    store,
    journalRoot: root,
    claimKeyId: 'key-1',
    now: () => NOW,
    adapter: {
      acquire,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      setOption: async () => undefined,
      answerPrompt: async () => {}
    }
  })
  try {
    expect((await host.attach({ callerKey: 'test' }, hostTestAttachParams(null))).ok).toBe(true)
    const sink = acquire.mock.calls[0]![0].events!
    const events: AgentSessionSubscribeEvent[] = []
    const stop = host.subscribe({
      id: 'scope',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const initial = host.history({ sessionId: SESSION, direction: 'tail' }).page.window.nextCursor
    for (const threadId of [THREAD, 'child-thread']) {
      sink.appendItem(
        { provider: 'codex', threadId, turnId: 'turn', ordinal: 0 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: threadId }]
        }
      )
    }
    sink.publish()
    await host.flushStreamedEvents(SESSION)
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.page.items.map((item) => item.body)).toEqual([
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: THREAD }] }
    ])
    expect(
      events.filter((event) => event.type === 'batch').flatMap((event) => event.batch.items)
    ).toEqual(history.page.items)
    stop()
    for (const cursor of [undefined, initial]) {
      const replay: AgentSessionSubscribeEvent[] = []
      const close = host.subscribe({
        id: 'reopen',
        sessionId: SESSION,
        cursor,
        emit: (event) => replay.push(event)
      })
      const items = replay.flatMap((event) =>
        event.type === 'end' ? [] : event.type === 'batch' ? event.batch.items : event.page.items
      )
      expect(items).toEqual(history.page.items)
      close()
    }
    const after = host.history({ sessionId: SESSION, direction: 'after', cursor: initial })
    expect(after.page.items).toEqual(history.page.items)
    expect(after.page.window.nextCursor.sequence).toBeGreaterThan(initial.sequence)
  } finally {
    await host.flushAllStreamedEvents()
    await rm(root, { recursive: true, force: true })
  }
})
