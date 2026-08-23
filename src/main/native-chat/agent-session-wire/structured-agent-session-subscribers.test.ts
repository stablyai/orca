import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionHandoffStatus,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const SESSION = 'subscriber-session'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-subscribers-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('AgentSessionSubscribers', () => {
  it('publishes handoff-only changes without serializing a transcript snapshot', async () => {
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const handoff: AgentSessionHandoffStatus = {
      owner: 'native',
      direction: 'to-tui',
      phase: 'switching',
      stage: 'preparing',
      operationId: 'handoff-1'
    }

    subscribers.handoff(SESSION, 2, handoff)

    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: journal.cursor(),
        items: [],
        removedItemIds: [],
        submissions: []
      },
      fence: 2,
      handoff
    })
  })
})
