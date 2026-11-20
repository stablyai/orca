import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { readTestHostJournal } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { seedTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { afterEach, expect, it, vi } from 'vitest'
import * as jsonlImport from '../../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import * as transcriptCatchUp from '../../transcripts/claude-transcript-catch-up'
import {
  chat,
  closeClaudeCatchUpChats,
  SESSION,
  PROVIDER
} from '../../transcripts/claude-transcript-catch-up.test-support'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from '../claude-structured-session-test-support'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
  await closeClaudeCatchUpChats()
})

async function openWithBlockedRecovery(outcome: 'success' | 'drop' | 'error' = 'success') {
  const c = await chat('batch')
  const claude = fakeClaude({ initSessionId: PROVIDER })
  const adapter = adapterAtPublishFor(claude, {
    providerSessionId: PROVIDER,
    resumeLeafUuid: 'old-leaf',
    resumesTranscript: true,
    cwd: c.cwd,
    claudeConfigDir: c.config
  })
  if (outcome === 'drop') {
    const replace = c.deferred.sink.tryReplaceHistory!.bind(c.deferred.sink)
    vi.spyOn(c.deferred.sink, 'tryReplaceHistory').mockImplementationOnce((replacement) => {
      Atomics.store(replacement.operation.guard.permit, 0, 0)
      return replace(replacement)
    })
  }
  const blocked = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<transcriptCatchUp.ClaudeTranscriptCatchUpOutcome>()
  const prepare = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await prepare(input)
    blocked.resolve(input.signal!)
    await release.promise
    if (outcome === 'error') {
      throw new Error('transcript read failed')
    }
    return prepared
  })
  const catchUp = transcriptCatchUp.catchUpClaudeTranscript
  vi.spyOn(transcriptCatchUp, 'catchUpClaudeTranscript').mockImplementation(async (input) => {
    const outcome = await catchUp(input)
    if (input.mode === 'recovery') {
      finished.resolve(outcome)
    }
    return outcome
  })
  let opened: Promise<unknown> | undefined
  cleanups.push(async () => {
    release.resolve()
    await opened?.catch(() => {})
    await adapter.closeAll()
    claude.dispose()
  })
  const acquired = await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 1,
    spawnToken: 'catch-up-open',
    events: c.deferred.sink
  })
  opened = adapter.open({
    sessionId: SESSION,
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  await opened
  adapter.startupSettled(SESSION, acquired.acquisitionGeneration)
  return {
    ...c,
    claude,
    adapter,
    opened,
    blocked: blocked.promise,
    release,
    finished: finished.promise
  }
}

it('opens the chat while capacity recovery is blocked, then installs the recent history', async () => {
  const c = await openWithBlockedRecovery()
  await c.blocked
  await expect(c.opened).resolves.toMatchObject({ newConversation: false })
  expect(await c.items()).not.toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ presentation: 'continued-outside-recent' })
    })
  )
  c.release.resolve()
  expect(await c.finished).toBe(true)
  const items = await c.items()
  expect(items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
      }
    })
  )
  expect(items).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ presentation: 'continued-outside-recent' })
    })
  )
})

it.each(['success', 'drop', 'error'] as const)(
  'holds sends until capacity recovery settles with %s',
  async (outcome) => {
    const c = await openWithBlockedRecovery(outcome)
    await c.blocked
    await c.opened
    expect(c.adapter.holdsDispatch(SESSION)).toBe('history-catch-up')
    const sent = c.adapter.dispatch({
      sessionId: SESSION,
      fence: 1,
      clientMessageId: 'live-prompt',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Keep my live turn' }]
      }
    })
    expect(c.claude.connections[0]!.sent).toEqual([])
    c.release.resolve()
    expect(await c.finished).toBe(outcome === 'success')
    await expect(sent).resolves.toMatchObject({ state: 'admitted' })
    expect(c.adapter.holdsDispatch(SESSION)).toBe(false)
    expect(
      (await c.items()).some(
        (item) =>
          item.body.kind === 'status' && item.body.presentation === 'continued-outside-recent'
      )
    ).toBe(outcome === 'success')
  }
)

it('releases the recovery hold when the session closes and drops the replacement', async () => {
  const c = await openWithBlockedRecovery()
  const signal = await c.blocked
  await c.opened
  expect(c.adapter.holdsDispatch(SESSION)).toBe('history-catch-up')
  await c.adapter.closeAll()
  expect(signal.aborted).toBe(true)
  expect(c.adapter.holdsDispatch(SESSION)).toBe(false)
  const cursor = await c.journal.reads.physicalCursor()
  c.release.resolve()
  expect(await c.finished).toBe(false)
  await c.deferred.sink.written?.()
  expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
})

it('keeps the send that acquires a restored chat queued until recovery commits, then delivers it once', async () => {
  const providerSessionId = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
  const c = await chat('batch', providerSessionId)
  await c.journal.appendItem(
    { provider: 'claude', sessionId: providerSessionId, uuid: 'unheld-turn' },
    { kind: 'turn', turnId: 'unheld-turn', state: 'running' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const record = agentSessionRecordFixture({
    sessionId: SESSION,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: c.config },
    location: { workspaceId: 'workspace' },
    providerHandleChain: [
      {
        linkId: 'saved-link',
        handle: claudeProviderHandle(providerSessionId, 'old-leaf'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 0
      }
    ]
  })
  await seedTestAgentSessionRecordStore(c.cwd, { records: [record] })
  const claude = fakeClaude({ initSessionId: providerSessionId })
  const adapter = adapterAtPublishFor(claude, {
    providerSessionId,
    resumeLeafUuid: 'old-leaf',
    resumesTranscript: true,
    continuesChain: true,
    cwd: c.cwd,
    claudeConfigDir: c.config
  })
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(c.cwd),
    adapter,
    journalDatabase: await openTestAgentSessionDatabase(c.cwd),
    claimKeyId: 'test-key',
    mintSpawnToken: () => 'recovery-send'
  })
  const blocked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const preparedImport = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await preparedImport(input)
    blocked.resolve()
    await release.promise
    return prepared
  })
  const delivered = Promise.withResolvers<void>()
  const dispatch = adapter.dispatch
  vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
    const outcome = await dispatch(input)
    delivered.resolve()
    return outcome
  })
  cleanups.push(async () => {
    release.resolve()
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
    claude.dispose()
  })
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Keep my original send' }]
  }
  const clientOperationId = '1800000000000-00000000000000000000000000000001'
  expect(
    await host.send(
      { callerKey: 'test-client' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
  ).toMatchObject({ ok: true })
  await blocked.promise
  const waiting = await readTestHostJournal(host, SESSION)
  const queued = waiting.submissions.find(
    (submission) => submission.clientMessageId === clientOperationId
  )
  expect(queued).toBeDefined()
  expect(queued?.handedOverAt).toBeUndefined()
  expect(claude.connections[0]!.sent).toEqual([])
  release.resolve()
  await delivered.promise
  const recovered = await readTestHostJournal(host, SESSION)
  expect(recovered.items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
      }
    })
  )
  expect(recovered.items).toContainEqual(expect.objectContaining({ body }))
  expect(
    claude.connections[0]!.sent.filter((message) =>
      JSON.stringify(message).includes('Keep my original send')
    )
  ).toHaveLength(1)
})
