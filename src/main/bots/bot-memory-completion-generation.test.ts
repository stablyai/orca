import { subscribeStructuredAgentSessionTurnContext } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { readTestHostJournal } from '../native-chat/agent-session-journal/journal-observation.test-support'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { createBotMemoryRecord, tagBotMemoryFile } from './bot-memory-record'
import { createBotTurnContext } from './bot-turn-context'
import { HELD_BOT_RULES } from './bot-turn-rules.test-fixture'
import { localBotHomeFilesystem } from './bot-home'
import { runLocalEditorWrite } from '../filesystem/local-file-io/local-disk-write-precondition'
import { FILE_WRITE_OK } from '../../shared/file-write/file-write-disk-precondition'

const SESSION = HOST_TEST_SESSION
const BOT = 'scout'
const FOLDER = join('bot-homes', BOT)
const TOPIC = join(FOLDER, 'memory', 'deploy.md')
const EDIT = {
  kind: 'tool-call',
  name: 'Edit',
  input: { file_path: TOPIC },
  state: 'completed'
} as const

function memory() {
  const files = new Map([
    [join(FOLDER, 'MEMORY.md'), '- Old fact\n'],
    [TOPIC, 'Old topic']
  ])
  const readStarted = Promise.withResolvers<void>()
  const resumeRead = Promise.withResolvers<void>()
  let holdTopicListing = false
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    listNames: async () => {
      if (holdTopicListing) {
        holdTopicListing = false
        readStarted.resolve()
        await resumeRead.promise
      }
      return ['deploy.md']
    },
    replaceText: async (path: string, expected: string, text: string) =>
      files.get(path) === expected && (files.set(path, text), true),
    writeText: async (path: string, text: string) => (files.set(path, text), true)
  }
  const record = createBotMemoryRecord(fs)
  const context = createBotTurnContext(fs, undefined, undefined, undefined, record)
  return {
    context,
    launched: () =>
      context.launched(
        SESSION,
        BOT,
        FOLDER,
        { soul: null, memory: '- Old fact\n' },
        true,
        HELD_BOT_RULES
      ),
    holdTopicListing: () => {
      holdTopicListing = true
    },
    readStarted: readStarted.promise,
    resumeRead: resumeRead.resolve,
    replaceTopic: () => files.set(TOPIC, 'Replacement topic'),
    drain: () => record.after(BOT, async () => undefined)
  }
}

it('leaves a replacement launch’s topic change pending when an older turn ends', async () => {
  const bot = memory()
  bot.launched()
  await bot.context.launchUpdate?.(SESSION)
  const notes: string[] = []
  bot.holdTopicListing()
  bot.context.turnEnded?.(
    SESSION,
    'old-turn',
    async () => ({
      items: [{ itemId: 'edit', revision: 1, sequence: 1, observedAt: 1, body: EDIT }],
      openerIds: new Map()
    }),
    async (_id, body) => {
      notes.push(body.text)
    }
  )
  try {
    await bot.readStarted
    bot.launched()
    await bot.context.launchUpdate?.(SESSION)
    bot.replaceTopic()
  } finally {
    bot.resumeRead()
    await bot.drain()
  }
  expect(notes).toEqual([])
  const next = await bot.context.plan(SESSION, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Check the topic.' }]
  })
  expect(next?.text).toContain('Replacement topic')
})

it('never publishes an old turn’s memory receipt through a replacement host acquisition', async () => {
  const bot = memory()
  bot.launched()
  const rig = await createQueuedMessageTestRig({
    restartable: true,
    hostDeps: { turnContext: bot.context }
  })
  const unsubscribe = subscribeStructuredAgentSessionTurnContext(rig.host)
  try {
    const send = rig.send('Check memory.')
    expect(await send.result).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(send.id, 'old')
    const oldFence = rig.store.getConversation(SESSION)!.currentFence
    const events = rig.providerEvents()
    events.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'old-turn', ordinal: 1001 },
      EDIT,
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    bot.holdTopicListing()
    events.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'old-turn', ordinal: 1000 },
      {
        kind: 'turn',
        turnId: 'old-turn',
        userItemId: agentJournalSubmissionKey(send.id),
        state: 'completed',
        outcome: 'success'
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await bot.readStarted

    await rig.host.close(SESSION, 'evict')
    const acquire = rig.host.deps.adapter.acquire.bind(rig.host.deps.adapter)
    rig.host.deps.adapter.acquire = async (input) => {
      bot.launched()
      return { ...(await acquire(input)), acquisitionGeneration: 'generation-2' }
    }
    rig.dispatch.mockImplementationOnce(async () => {
      bot.replaceTopic()
      return { state: 'admitted' }
    })
    const request = structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      clientOperationId: `1800000000000-${'9'.repeat(32)}`,
      expectedRuntimeFence: rig.store.getConversation(SESSION)!.currentFence,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Change the topic.' }] }
    })
    expect(
      await rig.host.send({ callerKey: 'client-1' }, { ...request, userSend: true })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.store.getConversation(SESSION)!.currentFence).toBeGreaterThan(oldFence)
    bot.resumeRead()
    await bot.drain()
    const { items } = await readTestHostJournal(rig.host, SESSION)
    expect(
      items.filter(
        ({ body }) => body.kind === 'status' && body.presentation === 'bot-memory-updated'
      )
    ).toEqual([])
  } finally {
    bot.resumeRead()
    await bot.drain()
    unsubscribe?.()
    await rig.dispose()
  }
})

it('keeps a delayed physical memory write behind its original lease', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-owned-bot-memory-'))
  const path = join(folder, 'MEMORY.md')
  const edited = '- Fresh fact\n'
  const before = '- Old fact\n'
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const seed = rig.send('Seed the conversation.')
    expect(await seed.result).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(seed.id, 'old')
    const fence = rig.store.getConversation(SESSION)!.currentFence
    const isCurrent = () => rig.store.getConversation(SESSION)!.currentFence === fence
    await writeFile(path, edited)
    await tagBotMemoryFile(
      localBotHomeFilesystem,
      folder,
      before,
      async () => null,
      undefined,
      isCurrent
    )
    expect(await readFile(path, 'utf8')).toContain('Old fact')

    await writeFile(path, edited)
    const locked = Promise.withResolvers<void>()
    const unlock = Promise.withResolvers<void>()
    const entering = Promise.withResolvers<void>()
    const hold = runLocalEditorWrite(path, async () => {
      locked.resolve()
      await unlock.promise
      return FILE_WRITE_OK
    })
    await locked.promise
    const pending = tagBotMemoryFile(
      {
        readText: localBotHomeFilesystem.readText,
        replaceText: (...args) => {
          entering.resolve()
          return localBotHomeFilesystem.replaceText(...args)
        }
      },
      folder,
      before,
      async () => null,
      undefined,
      isCurrent
    )
    const finished = Promise.allSettled([hold, pending])
    try {
      await entering.promise
      await rig.host.close(SESSION, 'evict')
      const replacement = structuredAgentSessionMessageSendMutation({
        sessionId: SESSION,
        clientOperationId: `1800000000000-${'8'.repeat(32)}`,
        expectedRuntimeFence: rig.store.getConversation(SESSION)!.currentFence,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue.' }] }
      })
      expect(
        await rig.host.send({ callerKey: 'client-1' }, { ...replacement, userSend: true })
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
      expect(isCurrent()).toBe(false)
    } finally {
      unlock.resolve()
      await finished
    }
    expect(await readFile(path, 'utf8')).toBe(edited)
    expect(await localBotHomeFilesystem.replaceText(path, before, 'stale content')).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(edited)
  } finally {
    await rig.dispose()
    await rm(folder, { recursive: true, force: true })
  }
})
