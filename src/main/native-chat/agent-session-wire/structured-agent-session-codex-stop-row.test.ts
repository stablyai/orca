// What a Stop's row says when Codex took the interrupt, against the real host, journal and Codex
// adapter. Codex answers a turn's interrupt as the turn aborts and sends the turn's end right after
// the answer, so the end reaches Orca a moment after the Stop has its answer.

import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stop-row-'))
  resetHostTestOperationIds()
  const codex = fakeCodex()
  const notify = (method: string, params: unknown): void =>
    codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  codex.routes['turn/start'] = turns.routes['turn/start']
  codex.routes['turn/interrupt'] = () => {
    const turnId = turns.turnId
    // The answer first, then the turn's end on a later read of Codex's output.
    setTimeout(
      () =>
        notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'interrupted' } }),
      4
    )
    return {}
  }
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapterFor(codex), { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function send(text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

async function runningTurn(): Promise<void> {
  expect(await send('count to 40')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  turns.start()
  await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['running']))
}

async function journalRows() {
  const items = (await host.journalSnapshot(SESSION)).items
  return {
    statuses: items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : [])),
    turns: items.flatMap((item) => (item.body.kind === 'turn' ? [item.body.state] : []))
  }
}

describe('a Codex Stop that Codex answered', () => {
  it.each([
    ['names no turn', undefined],
    ['names its turn, as an older client sends it', 'turn-1']
  ] as const)(
    'reads as requested, with the turn interrupted, when it %s',
    async (_case, turnId) => {
      await runningTurn()

      const stopped = await stop(turnId)
      await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['interrupted']))
      await host.flushStreamedEvents(SESSION)

      expect((await journalRows()).statuses).toEqual(['Cancellation requested.'])
      expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    }
  )
})
