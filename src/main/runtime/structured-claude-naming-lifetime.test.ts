import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as transcriptNaming from '../claude/claude-provider-session-rename'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { stopCreatedChat } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import {
  createClaudeNamingRuntime,
  nativeNamingTitle,
  writeNativeNamingConversation
} from './structured-claude-naming-test-support'

vi.mock('./structured-agent-model-catalog-wiring', () => ({
  modelCatalogHostDeps: async () => ({})
}))

it('settles fresh input while the actual outside append is held, then corrects only the overlapping chat', async ({
  onTestFinished
}) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime()
  let appended: string | undefined
  const append = transcriptNaming.renameClaudeTranscript
  const naming = vi
    .spyOn(transcriptNaming, 'renameClaudeTranscript')
    .mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      await append(...args)
      appended = await readFile(fixture.file, 'utf8')
    })
  onTestFinished(async () => {
    release.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({
    ok: true,
    value: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({ body: expect.objectContaining({ role: 'user' }) })
        ])
      }
    }
  })
  expect(
    host.deps.store.requireWritableRecord(HOST_TEST_SESSION).providerHandleChain
  ).toMatchObject([{ origin: 'adopted', handle: { nativeId: fixture.nativeId } }])
  expect(fixture.launches).toHaveLength(0)
  await expect(
    host.setUserConversationName(HOST_TEST_SESSION, 'New name', 'rename')
  ).resolves.toEqual({
    name: 'New name',
    applied: true
  })
  await entered.promise
  const sent = await fixture.send()
  expect(sent).toMatchObject({ ok: true })
  if (!sent.ok) {
    throw new Error('the fresh input was refused')
  }
  await vi.waitFor(async () => {
    const journal = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(
      journal.submissions.find((entry) => entry.clientMessageId === sent.value.clientMessageId)
    ).toMatchObject({
      dispatchState: 'accepted'
    })
    expect(journal.items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'NAMING_OK' }]
        })
      })
    )
  })
  expect(fixture.launches).toHaveLength(1)
  expect(fixture.launches[0]?.options).toMatchObject({ resume: fixture.nativeId })
  expect(await nativeNamingTitle(fixture.file)).toBe('Old')
  expect(fixture.controls).toEqual([])
  release.resolve()
  await vi.waitFor(() =>
    expect(fixture.controls).toEqual([{ name: 'New name', nativeId: fixture.nativeId }])
  )
  await stopStructuredAgentSessionRuntime()
  expect(await nativeNamingTitle(fixture.file)).toBe('New name')
  const pair = [
    expect.objectContaining({
      type: 'custom-title',
      customTitle: 'New name',
      sessionId: fixture.nativeId
    }),
    { type: 'agent-name', agentName: 'New name', sessionId: fixture.nativeId }
  ]
  expect(
    appended
      ?.trim()
      .split('\n')
      .slice(-2)
      .map((line) => JSON.parse(line))
  ).toEqual(pair)
  expect(
    (await readFile(fixture.file, 'utf8'))
      .trim()
      .split('\n')
      .slice(-2)
      .map((line) => JSON.parse(line))
  ).toEqual(pair)
  expect(naming).toHaveBeenCalledOnce()

  // A later independent native rename survives an unrelated true resume, even to an older spelling.
  for (const later of ['Independent CLI', 'Old']) {
    const laterPair = [
      { type: 'custom-title', sessionId: fixture.nativeId, customTitle: later },
      { type: 'agent-name', agentName: later, sessionId: fixture.nativeId }
    ]
    await transcriptNaming.appendTranscriptEntries(fixture.file, laterPair)
    await fixture.install()
    expect(await fixture.send('Unrelated continuation')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fixture.native.connections.at(-1)?.sent).toHaveLength(1))
    await stopStructuredAgentSessionRuntime()
    expect(await nativeNamingTitle(fixture.file)).toBe(later)
    expect(
      (await readFile(fixture.file, 'utf8'))
        .trim()
        .split('\n')
        .slice(-2)
        .map((line) => JSON.parse(line))
    ).toEqual(laterPair)
    expect(fixture.controls).toHaveLength(1)
    expect(naming).toHaveBeenCalledOnce()
  }
})

it('joins an issued control after stopDelivery before closing adapters and the database', async ({
  onTestFinished
}) => {
  const control = Promise.withResolvers<void>()
  const controlEntered = Promise.withResolvers<void>()
  let stopping: Promise<void> | undefined
  const fixture = await createClaudeNamingRuntime({
    beforeControl: async () => {
      controlEntered.resolve()
      await control.promise
    }
  })
  onTestFinished(async () => {
    control.resolve()
    try {
      await stopping
    } finally {
      try {
        await fixture.dispose()
      } finally {
        vi.restoreAllMocks()
      }
    }
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
  await host.setUserConversationName(HOST_TEST_SESSION, 'Accepted before quit', 'rename')
  await controlEntered.promise
  const adapter = host.deps.adapter
  if (!(adapter instanceof StructuredAgentSessionAdapterRouter)) {
    throw new Error('expected the installed runtime router')
  }
  const stopDelivery = vi.spyOn(host, 'stopDelivery')
  const closeAdapters = vi.spyOn(adapter, 'closeAll')
  const closeDatabase = vi.spyOn(host.deps.journalDatabase, 'close')
  stopping = stopStructuredAgentSessionRuntime()
  await vi.waitFor(() => expect(stopDelivery).toHaveBeenCalledOnce())
  host.deps.nameProviderConversation?.({
    ...host.deps.store.requireWritableRecord(HOST_TEST_SESSION),
    conversationName: 'Late push'
  })
  expect(fixture.controls).toEqual([{ name: 'Accepted before quit', nativeId: fixture.nativeId }])
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  control.resolve()
  await stopping
  expect(fixture.controls).toEqual([{ name: 'Accepted before quit', nativeId: fixture.nativeId }])
  expect(await nativeNamingTitle(fixture.file)).toBe('Accepted before quit')
  expect(fixture.native.connections).toHaveLength(1)
  expect(fixture.native.connections[0]?.exitVerdict).toEqual({ root: 'exited', tree: 'exited' })
  expect(closeAdapters).toHaveBeenCalledOnce()
  expect(closeDatabase).toHaveBeenCalledOnce()
})

it('joins already-issued root cleanup after startup expiry even when delivery and unissued follow-up stop', async ({
  onTestFinished
}) => {
  vi.useFakeTimers()
  const initialize = Promise.withResolvers<void>()
  const appendEntered = Promise.withResolvers<void>()
  const releaseAppend = Promise.withResolvers<void>()
  const appendFinished = Promise.withResolvers<void>()
  const warn = vi.fn()
  const closeEntered = Promise.withResolvers<void>()
  const rootExit = Promise.withResolvers<boolean>()
  let stopping: Promise<void> | undefined
  const fixture = await createClaudeNamingRuntime({
    initialize: initialize.promise,
    deps: { startupLimits: { ceilingMs: 5000 }, logger: { warn, error: vi.fn() } },
    beforeClose: () => {
      closeEntered.resolve()
      return rootExit.promise
    }
  })
  const append = transcriptNaming.renameClaudeTranscript
  vi.spyOn(transcriptNaming, 'renameClaudeTranscript').mockImplementation(async (...args) => {
    appendEntered.resolve()
    await releaseAppend.promise
    await append(...args)
    appendFinished.resolve()
  })
  onTestFinished(async () => {
    releaseAppend.resolve()
    initialize.resolve()
    rootExit.resolve(true)
    try {
      await stopping
    } finally {
      try {
        await fixture.dispose()
      } finally {
        vi.restoreAllMocks()
        vi.useRealTimers()
      }
    }
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.readStatusSummary(HOST_TEST_SESSION)?.hostExecutionPhase).toBe('starting')
  )
  await host.setUserConversationName(HOST_TEST_SESSION, 'Name after expiry', 'rename')
  await appendEntered.promise
  const stopDelivery = vi.spyOn(host, 'stopDelivery')
  const adapter = host.deps.adapter
  if (!(adapter instanceof StructuredAgentSessionAdapterRouter)) {
    throw new Error('expected the installed runtime router')
  }
  const closeAdapters = vi.spyOn(adapter, 'closeAll')
  const closeDatabase = vi.spyOn(host.deps.journalDatabase, 'close')
  stopping = stopStructuredAgentSessionRuntime()
  await vi.waitFor(() => expect(stopDelivery).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(5000)
  await closeEntered.promise
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  expect(fixture.native.connections[0]?.exitVerdict.root).toBe('live')
  releaseAppend.resolve()
  await appendFinished.promise
  await vi.advanceTimersByTimeAsync(0)
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  rootExit.resolve(true)
  await stopping
  expect(fixture.controls).toEqual([])
  // A failed-before-ready writer may finish its old title; the unissued correction is terminal.
  expect(await nativeNamingTitle(fixture.file)).toBe('Old')
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ scope: 'provider-session-rename' })
  )
  expect(fixture.native.connections[0]?.exitVerdict).toEqual({ root: 'exited', tree: 'exited' })
  expect(fixture.native.connections[0]?.closeCount).toBe(1)
  expect(closeAdapters).toHaveBeenCalledOnce()
  expect(closeDatabase).toHaveBeenCalledOnce()
})

it.each([true, false])(
  'joins a retiring writer before outside metadata (root proven=%s)',
  async (proven) => {
    const entered = Promise.withResolvers<void>()
    const rootExit = Promise.withResolvers<boolean>()
    let retry = false
    const warn = vi.fn()
    const fixture = await createClaudeNamingRuntime({
      deps: { logger: { warn, error: vi.fn() } },
      beforeClose: () => {
        entered.resolve()
        return retry ? Promise.resolve(true) : rootExit.promise
      }
    })
    const append = vi.spyOn(transcriptNaming, 'renameClaudeTranscript')
    onTestFinished(async () => {
      retry = true
      rootExit.resolve(true)
      await fixture.dispose()
      vi.restoreAllMocks()
    })
    await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
    const host = await fixture.install()
    expect(await fixture.create()).toMatchObject({ ok: true })
    expect(await fixture.send()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
    const adapter = host.deps.adapter
    if (!adapter.closeSession) {
      throw new Error('expected the runtime close boundary')
    }
    const closing = adapter.closeSession(HOST_TEST_SESSION)
    await entered.promise
    await host.setUserConversationName(HOST_TEST_SESSION, 'Refused until proven', 'rename')
    expect(append).not.toHaveBeenCalled()
    rootExit.resolve(proven)
    expect(await closing).toBe(proven)
    if (proven) {
      await vi.waitFor(async () =>
        expect(await nativeNamingTitle(fixture.file)).toBe('Refused until proven')
      )
      await stopStructuredAgentSessionRuntime()
      expect(warn).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ scope: 'provider-session-rename' })
      )
      expect(append).toHaveBeenCalledOnce()
      return
    }
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ scope: 'provider-session-rename' })
      )
    )
    expect(fixture.native.connections[0]?.exitVerdict.root).toBe('live')
    expect(await nativeNamingTitle(fixture.file)).toBe('Old')
    expect(append).not.toHaveBeenCalled()
    retry = true
    expect(await adapter.closeSession(HOST_TEST_SESSION)).toBe(true)
    await host.setUserConversationName(HOST_TEST_SESSION, 'After proven exit', 'rename')
    await vi.waitFor(async () =>
      expect(await nativeNamingTitle(fixture.file)).toBe('After proven exit')
    )
  }
)

it('retires a delivered-kill writer on its late expected exit, without replay, so fresh stopped renames work', async ({
  onTestFinished
}) => {
  const warn = vi.fn()
  const fixture = await createClaudeNamingRuntime({
    deps: { logger: { warn, error: vi.fn() } },
    beforeOpen: async (launch, connection) => {
      const emit = (message: Record<string, unknown>) =>
        connection.handlers.onMessage?.({
          ...message,
          session_id: launch.options.resume ?? launch.options.sessionId
        })
      connection.send = async (message, beforeDispatch) => {
        await beforeDispatch?.()
        connection.sent.push(message)
        emit({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' })
        emit(message)
        emit({
          type: 'assistant',
          uuid: randomUUID(),
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: 'Working' }]
          }
        })
      }
      connection.interrupt = async () => {
        connection.calls.push({ subtype: 'interrupt' })
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Interrupted',
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      }
      connection.close = async () => {
        connection.closed = true
        connection.closeCount++
        connection.exitVerdict = { root: 'live', tree: 'unverifiable', killDelivered: true }
        return true
      }
    }
  })
  onTestFinished(async () => {
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  const append = vi.spyOn(transcriptNaming, 'renameClaudeTranscript')
  const otherId = randomUUID()
  const otherFile = join(dirname(fixture.file), `${otherId}.jsonl`)
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  await writeNativeNamingConversation(otherFile, otherId, fixture.root, 'Other')
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.create(null, 'other-chat')).toMatchObject({ ok: true })
  const other = structuredClone(host.deps.store.requireWritableRecord('other-chat'))
  const sent = await fixture.send('Work until Stop')
  expect(sent).toMatchObject({ ok: true })
  if (!sent.ok) {
    throw new Error('expected the production send admission')
  }
  await vi.waitFor(async () => {
    const journal = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(journal.submissions).toContainEqual(
      expect.objectContaining({
        clientMessageId: sent.value.clientMessageId,
        dispatchState: 'accepted'
      })
    )
    expect(journal.items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Working' }]
        })
      })
    )
  })
  const connection = fixture.native.connections[0]
  if (!connection) {
    throw new Error('expected the acquired native connection')
  }
  expect(
    await stopCreatedChat(
      host,
      HOST_TEST_SESSION,
      host.deps.store.requireWritableRecord(HOST_TEST_SESSION).lease.runtimeFence
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host.loadedSessionIds()).not.toContain(HOST_TEST_SESSION))
  expect(
    host.deps.agents?.registration('claude')?.adapter.hasOwnedAcquisition?.(HOST_TEST_SESSION)
  ).toBe(false)
  expect(connection.closeCount).toBe(1)
  expect(connection.exitVerdict).toEqual({
    root: 'live',
    tree: 'unverifiable',
    killDelivered: true
  })
  const callsAfterStop = structuredClone(connection.calls)
  const original = await readFile(fixture.file, 'utf8')
  await host.setUserConversationName(HOST_TEST_SESSION, 'Before observed exit', 'rename')
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'provider-session-rename' })
    )
  )
  expect(append).not.toHaveBeenCalled()
  connection.exitVerdict = { root: 'exited', tree: 'exited', killDelivered: true }
  connection.handlers.onExit?.(new Error('late root exit after delivered Stop'), { expected: true })
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  expect(await readFile(fixture.file, 'utf8')).toBe(original)
  expect(connection.calls).toEqual(callsAfterStop)
  expect(append).not.toHaveBeenCalled()
  await host.setUserConversationName(HOST_TEST_SESSION, 'New', 'rename')
  await vi.waitFor(() =>
    expect(append.mock.settledResults.map((result) => result.type)).toEqual(['fulfilled'])
  )
  expect(await nativeNamingTitle(fixture.file)).toBe('New')
  await host.setUserConversationName(HOST_TEST_SESSION, 'New', 'rename')
  await vi.waitFor(() =>
    expect(append.mock.settledResults.map((result) => result.type)).toEqual([
      'fulfilled',
      'fulfilled'
    ])
  )
  expect(append.mock.calls).toEqual([
    [fixture.home, fixture.nativeId, 'New'],
    [fixture.home, fixture.nativeId, 'New']
  ])
  expect(await nativeNamingTitle(fixture.file)).toBe('New')
  expect(await nativeNamingTitle(otherFile)).toBe('Other')
  expect(host.deps.store.requireWritableRecord('other-chat')).toEqual(other)
  expect(fixture.launches).toHaveLength(1)
  expect(fixture.native.connections).toHaveLength(1)
  expect(fixture.controls).toEqual([])
  expect(connection.sent).toHaveLength(1)
  expect(connection.calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
  expect(connection.calls).toEqual(callsAfterStop)
  expect(connection.closeCount).toBe(1)
})

it('detaches a quit-before-ready follow-up without waiting for post-join closeAll', async ({
  onTestFinished
}) => {
  const initialize = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime({ initialize: initialize.promise })
  onTestFinished(async () => {
    initialize.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.readStatusSummary(HOST_TEST_SESSION)?.hostExecutionPhase).toBe('starting')
  )
  await host.setUserConversationName(HOST_TEST_SESSION, 'Before quit', 'rename')
  await vi.waitFor(async () => expect(await nativeNamingTitle(fixture.file)).toBe('Before quit'))
  await stopStructuredAgentSessionRuntime()
  expect(fixture.controls).toEqual([])
  expect(fixture.native.connections[0]?.exitVerdict.root).toBe('exited')
})
