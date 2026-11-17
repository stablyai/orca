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
let createSession: (options?: Record<string, string>, previousThreadId?: string) => TraexSession

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
  createSession = (options = {}, previousThreadId) =>
    new TraexSession(
      { identity, fence: 1, spawnToken: 'controls-spawn', events: sink.sink },
      {
        command: process.execPath,
        args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
        cwd: directory,
        previousThreadId: previousThreadId ?? null,
        mayBeUnsaved: false,
        options,
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
  session = createSession()
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
  session = createSession()
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
  session = createSession()
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

it('sends with standard-only and custom models despite inherited Max configuration', async () => {
  session = createSession()
  await session.open(new AbortController().signal)
  for (const model of ['small-id', 'custom-id']) {
    await session.setOption('model', model)
    const result = await dispatchTraexMessage(session, {
      sessionId: 'trae-controls',
      fence: 1,
      clientMessageId: model,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'model-switch' }] }
    })
    expect(result.state).toBe('accepted')
    await expect.poll(async () => (await journal.reads.newestTurn())?.state).toBe('completed')
  }
})

it('opens a standard-only model with inherited Max configuration', async () => {
  session = createSession({ model: 'small-id' })
  const opened = await session.open(new AbortController().signal)
  expect(opened.reportedOptions.model).toBe('small-id')
})

it('preserves the provider reason when a message is refused', async () => {
  session = createSession()
  await session.open(new AbortController().signal)
  const result = await dispatchTraexMessage(session, {
    sessionId: 'trae-controls',
    fence: 1,
    clientMessageId: 'model-rejected',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'model-rejected' }] }
  })
  expect(result).toMatchObject({
    state: 'rejected',
    rejection: { kind: 'providerRejected', detail: { text: 'Selected model is unavailable' } }
  })
})

it('delivers context picks and restores Max after a standard-only model', async () => {
  session = createSession({ model: 'contract-id', contextMode: 'max' })
  await session.open(new AbortController().signal)
  const send = async (clientMessageId: string) => {
    const previous = await journal.reads.newestTurn()
    const result = await dispatchTraexMessage(session, {
      sessionId: 'trae-controls',
      fence: 1,
      clientMessageId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'context-mode' }] }
    })
    expect(result.state).toBe('accepted')
    await expect
      .poll(async () => {
        const turn = await journal.reads.newestTurn()
        return turn?.turnId !== previous?.turnId ? turn?.state : null
      })
      .toBe('completed')
    const messages = (await readTestJournalItems(journal)).flatMap((row) =>
      row.body.kind === 'message' && row.body.role === 'assistant'
        ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    const receipt: unknown = JSON.parse(messages.at(-1)!)
    return receipt
  }
  await session.setOption('contextMode', 'standard')
  expect(await send('standard')).toEqual({ modelBackendVariant: null })
  await session.setOption('contextMode', 'max')
  expect(await send('max')).toEqual({ modelBackendVariant: 'max' })
  await session.setOption('model', 'small-id')
  expect(await send('small')).toEqual({ modelBackendVariant: null })
  await expect(session.setOption('contextMode', 'max')).rejects.toThrow(
    'TRAE CLI did not offer this context mode'
  )
  await session.setOption('model', 'contract-id')
  expect(await send('max-again')).toEqual({ modelBackendVariant: 'max' })
})

it('restores the CLI context mode and keeps picks out of the running turn', async () => {
  session = createSession({}, 'thread-trae-contract')
  const opened = await session.open(new AbortController().signal)
  expect(opened.reportedOptions.contextMode).toBe('max')
  await dispatchTraexMessage(session, {
    sessionId: 'trae-controls',
    fence: 1,
    clientMessageId: 'running',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'context-mode-wait' }] }
  })
  await session.setOption('contextMode', 'standard')
  await expect(
    dispatchTraexMessage(session, {
      sessionId: 'trae-controls',
      fence: 1,
      clientMessageId: 'changed-mode',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'context-mode' }] }
    })
  ).rejects.toThrow('TRAE CLI model changes apply to the next turn')
  expect(session.readOptions().current.contextMode).toBe('standard')
})
