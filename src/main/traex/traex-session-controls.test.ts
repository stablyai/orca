import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestAgentSessionDatabase } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { readTestJournalItems } from '../native-chat/agent-session-journal/journal-observation.test-support'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { agentJournalTurnBody } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { dispatchTraexMessage } from './traex-message-dispatch'
import { TraexSession } from './traex-session'

let directory: string
let journal: AgentSessionJournal
let session: TraexSession
let drained: () => Promise<void>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-trae-controls-'))
  const identity = {
    sessionId: 'trae-controls',
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  journal = await AgentSessionJournal.open({
    identity,
    database: await openTestAgentSessionDatabase(directory)
  })
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  sink.bind({ journal, fence: 1, publish: () => {} })
  drained = async () => {
    await sink.drained()
  }
  session = new TraexSession(
    { identity, fence: 1, spawnToken: 'controls-spawn', events: sink.sink },
    {
      command: process.execPath,
      args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
      cwd: directory,
      previousThreadId: null,
      mayBeUnsaved: false,
      options: {},
      permissionMode: 'ask'
    },
    { logger, onLifecycle: () => {}, onSettled: () => {} }
  )
})

afterEach(async () => {
  await session.close()
  await session.retire()
  await journal.close()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

async function permissionReceipt(decision: string | null, withdraw = false) {
  await dispatchTraexMessage(session, {
    sessionId: 'trae-controls',
    fence: 1,
    clientMessageId: `permissions-${decision ?? 'cancel'}-${withdraw ? 'withdraw' : 'answer'}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'permissions' }] }
  })
  await expect
    .poll(async () => {
      await drained()
      return (await readTestJournalItems(journal)).some(
        (row) => row.body.kind === 'approval' && row.body.resolution.state === 'pending'
      )
    })
    .toBe(true)
  const prompt = (await readTestJournalItems(journal)).find(
    (row) => row.body.kind === 'approval' && row.body.resolution.state === 'pending'
  )!
  if (withdraw) {
    session.prompts!.withdraw()
  } else {
    await session.prompts!.answer(
      prompt.itemId,
      decision === null ? null : { kind: 'option', optionId: decision },
      async () => {}
    )
  }
  await expect.poll(async () => (await journal.reads.newestTurn())?.state).toBe('completed')
  const replies = (await readTestJournalItems(journal)).flatMap((row) =>
    row.body.kind === 'message' && row.body.role === 'assistant'
      ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
  const receipt: unknown = JSON.parse(replies.at(-1)!)
  return receipt
}

it('grants permissions only for explicit approvals, including dismissal and withdrawal', async () => {
  await session.open(new AbortController().signal)
  expect(await permissionReceipt(null)).toEqual({ permissions: {}, scope: 'turn' })
  expect(await permissionReceipt(null, true)).toEqual({ permissions: {}, scope: 'turn' })
  expect(await permissionReceipt('decline')).toEqual({ permissions: {}, scope: 'turn' })
  expect(await permissionReceipt('accept')).toEqual({
    permissions: { network: { enabled: true }, fileSystem: { write: ['/workspace'] } },
    scope: 'turn'
  })
  expect(await permissionReceipt('acceptStrict')).toEqual({
    permissions: { network: { enabled: true }, fileSystem: { write: ['/workspace'] } },
    scope: 'turn',
    strictAutoReview: true
  })
  expect(await permissionReceipt('acceptForSession')).toEqual({
    permissions: { network: { enabled: true }, fileSystem: { write: ['/workspace'] } },
    scope: 'session'
  })
})

it('settles successful and failed recaps delivered together with their RPC replies', async () => {
  await session.open(new AbortController().signal)
  const recap = async (turnId: string) => {
    const identity = { provider: 'orca' as const, clientMessageId: turnId }
    const running = agentJournalTurnBody({ turnId, state: 'running' })
    await journal.appendItem(identity, running, { fence: 1, turnScope: { kind: 'thread' } })
    await session.extras.recap({
      clientMessageId: turnId,
      turnId,
      identity,
      resultIdentity: identity,
      running
    })
    await drained()
    return journal.reads.newestTurn()
  }
  expect(await recap('recap-success')).toMatchObject({ state: 'completed', outcome: 'success' })
  expect(await recap('recap-failure')).toMatchObject({ state: 'completed', outcome: 'failure' })
})

it('handles numeric sandbox completions before startup history is released', async () => {
  await session.connection.initialize()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const prepare = (cwd: string) => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      return session.extras.prepareWindowsSandbox(cwd, 'ask')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }
  await prepare(directory)
  await prepare('sandbox-failure')
  await session.open(new AbortController().signal)
  expect(session.readOptions().current.reportedPermissionMode).toBe('ask')
})
