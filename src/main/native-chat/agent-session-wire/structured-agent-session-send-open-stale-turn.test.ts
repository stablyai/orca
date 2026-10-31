import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

import { cp, rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

const relaunchedRoots: string[] = []

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function relaunchAfterCrashMidTurn(
  probe: AgentSessionOwnerProbe,
  { reconcile = true }: { reconcile?: boolean } = {}
) {
  const dying = hostTestState()
  await attach()
  const events = dying.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'crashed-turn', ordinal: 1 },
    { kind: 'turn', turnId: 'crashed-turn', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await dying.host.flushStreamedEvents(SESSION)
  // Empty renewal drains preceding record writes before copying crash state.
  await dying.store.renewLeases([])
  const relaunched = `${dying.root}-relaunched`
  relaunchedRoots.push(relaunched)
  await cp(dying.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const store = await openTestAgentSessionRecordStore(relaunched)
  const acquire = vi.fn(async () => {
    throw new Error('claude: command not found')
  })
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: { ...adapter(), acquire },
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => probe,
    now: () => NOW
  })
  if (reconcile) {
    await host.reconcileRestartLeases()
  }
  replaceHostTestState({ store, host })
  return { host, acquire }
}

async function turnStates(host: StructuredAgentSessionHost) {
  return (await host.journalSnapshot(SESSION)).items
    .flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    .map((turn) => turn.state)
}

// Read-open settles old work without claiming ownership; death proof alone permits interrupted.
const PROBES = [
  ['the old owner is proven gone', { outcome: 'pid-absent' }, 'interrupted'],
  [
    'nothing proves the old owner gone',
    { outcome: 'indeterminate', reason: 'This host cannot probe structured session owners.' },
    'unverifiable'
  ]
] as const satisfies readonly (readonly [string, AgentSessionOwnerProbe, string])[]

it.each(PROBES)(
  'settles a turn a dead generation left running when a send opens the chat and its start fails, when %s',
  async (_when, probe, settled) => {
    const { host, acquire } = await relaunchAfterCrashMidTurn(probe)
    expect(host.hasSession(SESSION)).toBe(false)

    const body = hostTestMessage('sent to a chat nobody has open')
    const sendEnvelope = envelope('agentSession.send', { body })
    await expect(host.send(CALLER, { envelope: sendEnvelope, body })).resolves.toMatchObject({
      ok: true
    })
    await eventually(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === sendEnvelope.clientOperationId
        )
      ).toMatchObject({ dispatchState: 'rejected' })
    )

    expect(acquire).toHaveBeenCalledOnce()
    expect(await turnStates(host)).toEqual([settled])
    await host.flushAllStreamedEvents()
  }
)

it.each(PROBES)(
  'settles the same turn when a reader opens the chat, when %s',
  async (_when, probe, settled) => {
    const { host } = await relaunchAfterCrashMidTurn(probe)

    await host.revealSession(SESSION)

    expect(await turnStates(host)).toEqual([settled])
    await host.flushAllStreamedEvents()
  }
)

// First read may precede startup reconciliation; later proof must revise its unverifiable settlement.
it('settles it when a read reaches the chat before the startup reconcile, then revises it', async () => {
  const { host } = await relaunchAfterCrashMidTurn({ outcome: 'pid-absent' }, { reconcile: false })
  expect(hostTestState().store.getRecord(SESSION)?.lease.claimStatus).toBe('live')

  await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(await turnStates(host)).toEqual(['unverifiable'])
  await host.reconcileRestartLeases()
  await openTestChats(host, [SESSION])

  expect(await turnStates(host)).toEqual(['interrupted'])
  await host.flushAllStreamedEvents()
})
