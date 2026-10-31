import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from '../claude/structured/claude-structured-session-id'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { CREATE_TEST_CALLER } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as transcriptNaming from '../claude/claude-provider-session-rename'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
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

it.each([10, 100])(
  'coalesces %i applied commits while joining real append, then honors a fresh equal-text occurrence',
  async (count) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fixture = await createClaudeNamingRuntime()
    const append = transcriptNaming.renameClaudeTranscript
    const calls = vi
      .spyOn(transcriptNaming, 'renameClaudeTranscript')
      .mockImplementation(async (...args) => {
        entered.resolve()
        await release.promise
        await append(...args)
      })
    onTestFinished(async () => {
      release.resolve()
      await fixture.dispose()
      vi.restoreAllMocks()
    })
    await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
    const host = await fixture.install()
    expect(await fixture.create()).toMatchObject({ ok: true })
    const inventory = vi.spyOn(transcriptFs, 'wslGatedReaddir')
    await host.setUserConversationName(HOST_TEST_SESSION, 'First', 'rename')
    await entered.promise
    for (let i = 1; i <= count; i++) {
      await host.setUserConversationName(HOST_TEST_SESSION, `Name ${i}`, 'rename')
    }
    expect(calls).toHaveBeenCalledTimes(1)
    expect(host.deps.store.requireWritableRecord(HOST_TEST_SESSION).conversationName).toBe(
      `Name ${count}`
    )
    release.resolve()
    await vi.waitFor(async () =>
      expect(await nativeNamingTitle(fixture.file)).toBe(`Name ${count}`)
    )
    expect(calls.mock.calls.map(([, , name]) => name)).toEqual(['First', `Name ${count}`])
    expect(inventory).toHaveBeenCalledTimes(2)
    await host.setUserConversationName(HOST_TEST_SESSION, `Name ${count}`, 'rename')
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(3))
    await stopStructuredAgentSessionRuntime()
    expect(inventory).toHaveBeenCalledTimes(3)
    expect(fixture.controls).toEqual([])
    const entries = (await readFile(fixture.file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      entries.filter((entry) => entry.type === 'custom-title').map((entry) => entry.customTitle)
    ).toEqual(['Old', 'First', `Name ${count}`, `Name ${count}`])
    expect(entries.filter((entry) => entry.type === 'agent-name')).toEqual(
      ['Old', 'First', `Name ${count}`, `Name ${count}`].map((name) => ({
        type: 'agent-name',
        agentName: name,
        sessionId: fixture.nativeId
      }))
    )
  }
)

it('observes a start during argument resolution and waits for real readiness after unpublished open', async ({
  onTestFinished
}) => {
  const argumentsReady = Promise.withResolvers<string[]>()
  const opening = Promise.withResolvers<void>()
  const publish = Promise.withResolvers<void>()
  let holdArguments = false
  const fixture = await createClaudeNamingRuntime({
    deps: {
      resolveLaunchArgs: () => {
        if (holdArguments) {
          holdArguments = false
          return argumentsReady.promise
        }
        return []
      }
    },
    beforeOpen: async () => {
      opening.resolve()
      await publish.promise
    }
  })
  onTestFinished(async () => {
    argumentsReady.resolve([])
    publish.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  holdArguments = true
  await host.setUserConversationName(HOST_TEST_SESSION, 'Before acquisition', 'rename')
  expect(await fixture.send()).toMatchObject({ ok: true })
  await opening.promise
  argumentsReady.resolve([])
  await vi.waitFor(async () =>
    expect(await nativeNamingTitle(fixture.file)).toBe('Before acquisition')
  )
  expect(fixture.controls).toEqual([])
  publish.resolve()
  await vi.waitFor(() =>
    expect(fixture.controls).toEqual([{ name: 'Before acquisition', nativeId: fixture.nativeId }])
  )
  await vi.waitFor(async () =>
    expect((await host.journalSnapshot(HOST_TEST_SESSION)).submissions).toContainEqual(
      expect.objectContaining({ dispatchState: 'accepted' })
    )
  )
  await stopStructuredAgentSessionRuntime()
  expect(await nativeNamingTitle(fixture.file)).toBe('Before acquisition')
})

it('keeps an accepted old-context append separate from Clear and names the committed new context once', async ({
  onTestFinished
}) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime()
  const append = transcriptNaming.renameClaudeTranscript
  vi.spyOn(transcriptNaming, 'renameClaudeTranscript').mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    await append(...args)
  })
  onTestFinished(async () => {
    release.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  await host.setUserConversationName(HOST_TEST_SESSION, 'Original context', 'rename')
  await entered.promise
  const fields = { command: 'clear' as const }
  expect(
    await host.conversationCommand(CREATE_TEST_CALLER, {
      ...fields,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: fixture.operationId(),
        expectedRuntimeFence:
          host.deps.store.requireWritableRecord(HOST_TEST_SESSION).lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: HOST_TEST_SESSION,
          fields
        })
      }
    })
  ).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections.at(-1)?.sent).toHaveLength(1))
  const replacement = fixture.launches.at(-1)?.options.sessionId
  expect(replacement).toEqual(expect.any(String))
  expect(replacement).not.toBe(fixture.nativeId)
  expect(await fixture.create(fixture.file, 'adopter-y')).toMatchObject({ ok: true })
  expect(await fixture.send('Another chat adopts the old UUID', 'adopter-y')).toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(fixture.native.connections.at(-1)?.sent).toHaveLength(1))
  release.resolve()
  await vi.waitFor(() =>
    expect(fixture.controls).toEqual([{ name: 'Original context', nativeId: replacement }])
  )
  await stopStructuredAgentSessionRuntime()
  expect(fixture.controls.some((entry) => entry.nativeId === fixture.nativeId)).toBe(false)
  expect(await nativeNamingTitle(join(dirname(fixture.file), `${replacement}.jsonl`))).toBe(
    'Original context'
  )
})

it('ends a failed unpublished start and never replays its occurrence on a later successful resume', async ({
  onTestFinished
}) => {
  const opened = Promise.withResolvers<void>()
  const fail = Promise.withResolvers<void>()
  let first = true
  const fixture = await createClaudeNamingRuntime({
    beforeOpen: async () => {
      if (first) {
        first = false
        opened.resolve()
        await fail.promise
        throw new Error('native open failed')
      }
    }
  })
  onTestFinished(async () => {
    fail.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await opened.promise
  await host.setUserConversationName(HOST_TEST_SESSION, 'Finite intent', 'rename')
  await vi.waitFor(async () => expect(await nativeNamingTitle(fixture.file)).toBe('Finite intent'))
  fail.resolve()
  await vi.waitFor(() => expect(fixture.native.connections[0]?.exitVerdict.root).toBe('exited'))
  await stopStructuredAgentSessionRuntime()
  const before = await readFile(fixture.file, 'utf8')
  await fixture.install()
  expect(await fixture.send('Later ordinary resume')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections.at(-1)?.sent).toHaveLength(1))
  await stopStructuredAgentSessionRuntime()
  expect(fixture.controls).toEqual([])
  expect((await readFile(fixture.file, 'utf8')).startsWith(before)).toBe(true)
})

it('inherits a committed manual name on a genuinely ready fresh conversation, without an old resume latch', async ({
  onTestFinished
}) => {
  const initialize = Promise.withResolvers<void>()
  const warn = vi.fn()
  const fixture = await createClaudeNamingRuntime({
    initialize: initialize.promise,
    deps: { logger: { warn, error: vi.fn() } }
  })
  onTestFinished(async () => {
    initialize.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  const host = await fixture.install()
  expect(await fixture.create(null)).toMatchObject({ ok: true })
  await host.setUserConversationName(HOST_TEST_SESSION, 'Fresh conversation', 'rename')
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'provider-session-rename' })
    )
  )
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.launches).toHaveLength(1))
  expect(fixture.controls).toEqual([])
  const nativeId = fixture.launches[0]?.options.sessionId
  expect(nativeId).toEqual(expect.any(String))
  initialize.resolve()
  await vi.waitFor(() =>
    expect(fixture.controls).toEqual([{ name: 'Fresh conversation', nativeId }])
  )
  await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
  await stopStructuredAgentSessionRuntime()
  expect(await nativeNamingTitle(join(dirname(fixture.file), `${nativeId}.jsonl`))).toBe(
    'Fresh conversation'
  )
})

it('names the materialized committed rewind fork at rest and never replays it on ordinary resume', async ({
  onTestFinished
}) => {
  const fixture = await createClaudeNamingRuntime()
  let stopping: Promise<void> | undefined
  onTestFinished(async () => {
    try {
      await stopping
    } finally {
      await fixture.dispose()
      vi.restoreAllMocks()
    }
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  await host.setUserConversationName(HOST_TEST_SESSION, 'Fork inherits', 'rename')
  await vi.waitFor(async () => expect(await nativeNamingTitle(fixture.file)).toBe('Fork inherits'))
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
  await host.close(HOST_TEST_SESSION, 'evict')
  await transcriptNaming.appendTranscriptEntries(fixture.file, [
    { type: 'custom-title', sessionId: fixture.nativeId, customTitle: 'Independent source title' },
    { type: 'agent-name', agentName: 'Independent source title', sessionId: fixture.nativeId }
  ])
  const source = await readFile(fixture.file, 'utf8')
  const journal = await host.journalSnapshot(HOST_TEST_SESSION)
  const prompt = journal.items.findLast(
    (item) => item.body.kind === 'message' && item.body.role === 'user'
  )
  if (!prompt) {
    throw new Error('expected the actual dispatched prompt in the journal')
  }
  const fields = { itemId: prompt.itemId, expectedEpoch: journal.cursor.epoch }
  expect(
    await host.rewind(CREATE_TEST_CALLER, {
      ...fields,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: fixture.operationId(),
        expectedRuntimeFence:
          host.deps.store.requireWritableRecord(HOST_TEST_SESSION).lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.rewind',
          sessionId: HOST_TEST_SESSION,
          fields
        })
      }
    })
  ).toMatchObject({ ok: true })
  const fork = host.deps.store.requireWritableRecord(HOST_TEST_SESSION).rewind?.providerFork
  expect(fork?.materialized).toBe(true)
  if (!fork) {
    throw new Error('expected a committed native fork')
  }
  const destination = join(dirname(fixture.file), `${fork.sessionId}.jsonl`)
  await vi.waitFor(async () => expect(await nativeNamingTitle(destination)).toBe('Fork inherits'))
  expect(fixture.launches).toHaveLength(1)
  expect(fixture.controls).toEqual([])
  expect(await nativeNamingTitle(fixture.file)).toBe('Independent source title')
  expect(await readFile(fixture.file, 'utf8')).toBe(source)
  expect(
    (await readFile(destination, 'utf8'))
      .trim()
      .split('\n')
      .slice(-2)
      .map((line) => JSON.parse(line))
  ).toEqual([
    expect.objectContaining({
      type: 'custom-title',
      customTitle: 'Fork inherits',
      sessionId: fork.sessionId
    }),
    { type: 'agent-name', agentName: 'Fork inherits', sessionId: fork.sessionId }
  ])
  const laterPair = [
    { type: 'custom-title', sessionId: fork.sessionId, customTitle: 'Later fork CLI' },
    { type: 'agent-name', agentName: 'Later fork CLI', sessionId: fork.sessionId }
  ]
  await transcriptNaming.appendTranscriptEntries(destination, laterPair)
  const previous = fixture.native.connections.at(-1)
  const connectionCount = fixture.native.connections.length
  const launchCount = fixture.launches.length
  const sent = await fixture.send('Resume the fork')
  expect(sent).toMatchObject({ ok: true })
  if (!sent.ok) {
    throw new Error('fork resume send was refused')
  }
  const uuid = claudePromptUuidForSubmission(
    HOST_TEST_SESSION,
    agentJournalSubmissionKey(sent.value.clientMessageId)
  )
  await vi.waitFor(async () => {
    const connection = fixture.native.connections[connectionCount]
    expect(connection).toBeDefined()
    expect(connection).not.toBe(previous)
    expect(connection?.launch).toBe(fixture.launches[launchCount])
    expect(connection?.sent).toContainEqual(
      expect.objectContaining({
        type: 'user',
        uuid,
        message: { role: 'user', content: [{ type: 'text', text: 'Resume the fork' }] }
      })
    )
    expect(
      (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
        (submission) => submission.clientMessageId === sent.value.clientMessageId
      )
    ).toMatchObject({ dispatchState: 'accepted' })
  })
  stopping = stopStructuredAgentSessionRuntime()
  await stopping
  expect(fixture.launches[launchCount]?.options.resume).toBe(fork.sessionId)
  expect(await nativeNamingTitle(destination)).toBe('Later fork CLI')
  expect(
    (await readFile(destination, 'utf8'))
      .trim()
      .split('\n')
      .slice(-2)
      .map((line) => JSON.parse(line))
  ).toEqual(laterPair)
  expect(await readFile(fixture.file, 'utf8')).toBe(source)
  expect(fixture.controls).toEqual([])
})
