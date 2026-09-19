import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { currentStructuredSessionLiveItems } from './structured-agent-session-live-items'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'

it('attributes sink commits, not same-fence imports, and keeps completed batch ordering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-session-items-'))
  const journal = await openAgentSessionJournal({
    journalDir: root,
    identity: {
      sessionId: 'session',
      hostId: 'local',
      workspaceId: 'folder',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread' }
    }
  })
  const sink = createDeferredStructuredAgentSessionEventSink()
  sink.bind({ journal, fence: 2, publish: () => {} })
  const identity = (turnId: string) =>
    ({ provider: 'codex', threadId: 'thread', turnId, ordinal: 1 }) as const
  const current = () => currentStructuredSessionLiveItems(journal, 2, journal.snapshot().items)
  try {
    await journal.appendItem(
      identity('imported'),
      { kind: 'turn', turnId: 'imported', state: 'running' },
      { fence: 2 }
    )
    expect(current()).toEqual([])
    sink.sink.appendItem(identity('one'), { kind: 'turn', turnId: 'one', state: 'running' })
    await sink.drained()
    expect(activeStructuredAgentSessionTurnId(current())).toBe('one')
    sink.sink.appendLifecycleBatch?.('completed-two', [
      {
        kind: 'item',
        identity: identity('two'),
        body: { kind: 'turn', turnId: 'two', state: 'completed' }
      }
    ])
    await sink.drained()
    expect(activeStructuredAgentSessionTurnId(current())).toBeNull()
    expect(currentStructuredSessionLiveItems(journal, 3, journal.snapshot().items)).toEqual([])
    await journal.appendItem(
      identity('one'),
      { kind: 'turn', turnId: 'one', state: 'running' },
      { fence: 2 }
    )
    expect(current().map((item) => item.body)).not.toContainEqual({
      kind: 'turn',
      turnId: 'one',
      state: 'running'
    })
  } finally {
    sink.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})
