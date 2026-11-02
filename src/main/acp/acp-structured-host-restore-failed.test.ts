import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { persistRewindRecord } from '../native-chat/agent-session-wire/structured-rewind-recovery'
import {
  readContextTransfers,
  contextTransferDelivered,
  currentContextTransferTarget
} from '../native-chat/agent-session-journal/context-transfer-repository'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as contextTransferEcho from '../native-chat/agent-session-journal/context-transfer-echo'
import {
  instrumentContextTransferFacts,
  seedClosedContextHistories
} from '../native-chat/agent-session-journal/context-transfer-scaling.test-support'
import { z } from 'zod'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { GROK, GROK_CONFIG_OPTIONS, PROVIDER_SESSION } from './acp-structured-adapter.test-support'
import { ACP_HANDLE_TRANSPORT } from './acp-structured-agent-definitions'
import { restoreJournal } from '../native-chat/agent-session-journal/journal-open'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import {
  attachParams,
  openHostRig,
  promptIdOf,
  RESUMES,
  send
} from './acp-structured-host.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

const FRESH = 'grok-fresh-session'
const FRESH_2 = 'grok-second-fresh-session'
const keyOf = (nativeId: string) =>
  agentSessionProviderHandleKey({ transport: ACP_HANDLE_TRANSPORT, agent: 'grok', nativeId })

type Lost = Map<string, { code: number; message: string }>

function sessionsLost(
  loads: string[],
  lost: Lost,
  replays: Map<string, (agent: AcpScriptedAgent) => void>
) {
  const opened = [PROVIDER_SESSION, FRESH, FRESH_2]
  return (agent: AcpScriptedAgent) => {
    agent.on('session/new', (frame) => {
      agent.reply(frame, {
        sessionId: opened.shift() ?? 'grok-unexpected-session',
        configOptions: GROK_CONFIG_OPTIONS
      })
    })
    agent.on('session/load', (frame) => {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(frame.params)
      loads.push(sessionId)
      const failure = lost.get(sessionId)
      if (failure) {
        agent.fail(frame, failure.code, failure.message)
      } else {
        replays.get(sessionId)?.(agent)
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      }
    })
  }
}

async function openRestoreRig(code: number, message: string) {
  const loads: string[] = []
  const replays = new Map<string, (agent: AcpScriptedAgent) => void>()
  const lost: Lost = new Map([[PROVIDER_SESSION, { code, message }]])
  const resolver: { resolve: ReturnType<typeof createAcpStructuredLaunchResolver> | null } = {
    resolve: null
  }
  const opened = await openHostRig({
    initialize: RESUMES,
    script: sessionsLost(loads, lost, replays),
    deps: {
      resolveLaunch: (input) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve(input)
      },
      readLaunch: (identity) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve({ identity })
      }
    }
  })
  const { rig, host, store, journalDatabase } = opened
  resolver.resolve = createAcpStructuredLaunchResolver(GROK, {
    store,
    readJournal: (sessionId) => restoreJournal(journalDatabase.db, sessionId),
    resolveWorkspacePath: async () => '/workspace',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveCommand: () => '/fake/grok'
  })
  const warnings = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items.filter(
      (row) =>
        row.body.kind === 'status' &&
        readAgentSessionFailureFact(row.body.failure)?.kind === 'sessionNotRestored'
    )
  }
  const exchange = async (text: string, reply: string, providerSession: string) => {
    const index = rig.sent('session/prompt').length
    await send(host, text)
    const prompt = await rig.frame('session/prompt', index)
    expect(prompt.params).toMatchObject({ sessionId: providerSession })
    rig.child().agent.notify('session/update', {
      sessionId: providerSession,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      _meta: { promptId: promptIdOf(prompt) }
    })
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    return prompt
  }
  return { ...opened, loads, lost, replays, warnings, exchange }
}

describe('a saved Grok session Grok cannot reopen', () => {
  it('continues the chat in a fresh session that the chain records and the next reopen loads', async () => {
    const { host, store, fence, loads, warnings, ready, exchange } = await openRestoreRig(
      -32603,
      'session file is corrupt'
    )

    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    expect(agentSessionProviderHandleChainHead(chain)).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    expect(await warnings()).toEqual([])

    await exchange('still there?', 'yes', FRESH)
    const messages = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => (row.body.kind === 'message' ? row.body.blocks : []))
    expect(messages.flat()).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'still there?' },
        { type: 'text', text: 'yes' }
      ])
    )

    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(store.getRecord(SESSION)?.providerHandleChain).toHaveLength(3)
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
  })
})

describe('a created Grok session Grok reports missing on the first reopen', () => {
  it('hands saved context to the next prompt without changing the user bubble', async () => {
    const { host, store, fence, loads, warnings, ready, exchange, messages, journalDatabase } =
      await openRestoreRig(-32002, 'Resource not found')
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await exchange('remember 42', 'noted', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    const head = agentSessionProviderHandleChainHead(chain)
    expect(head).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    expect(head?.supersedesKey).toBeUndefined()
    expect(await warnings()).toHaveLength(0)
    expect(await messages()).toEqual(expect.arrayContaining(['remember 42', 'noted']))
    const before = readContextTransfers(journalDatabase.db, SESSION)
    const target = currentContextTransferTarget(before)!
    expect(contextTransferDelivered(before, target.id)).toBe(false)
    const prompt = await exchange('what was the number?', '42', FRESH)
    const encoded = JSON.stringify(prompt.params)
    expect(encoded).toContain('remember 42')
    expect(encoded).toContain('noted')
    expect(encoded).toContain('orca_context_handoff')
    expect(encoded).toContain('User message:')
    expect(await messages()).toEqual(['remember 42', 'noted', 'what was the number?', '42'])
    expect(
      contextTransferDelivered(readContextTransfers(journalDatabase.db, SESSION), target.id)
    ).toBe(true)

    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
  })

  it('sends Compact as the exact control and leaves saved context owed for the next input', async () => {
    const { host, fence, ready, exchange, rig, journalDatabase } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await exchange('remember command context 42', 'saved for the next command', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    const target = currentContextTransferTarget(readContextTransfers(journalDatabase.db, SESSION))!
    const promptIndex = rig.sent('session/prompt').length
    const result = await host.conversationCommand(CALLER, {
      command: 'compact',
      envelope: envelope(
        'agentSession.conversationCommand',
        { command: 'compact' },
        { expectedRuntimeFence: fence() }
      )
    })
    expect(result).toMatchObject({ ok: true, value: { state: 'completed' } })
    const prompt = await rig.frame('session/prompt', promptIndex)
    expect(prompt.params).toMatchObject({ prompt: [{ type: 'text', text: '/compact' }] })
    expect(z.object({ prompt: z.array(z.unknown()) }).parse(prompt.params).prompt).toHaveLength(1)
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const afterCompact = readContextTransfers(journalDatabase.db, SESSION)
    expect(afterCompact.some((row) => row.kind === 'delivery')).toBe(false)
    expect(contextTransferDelivered(afterCompact, target.id)).toBe(false)

    const next = await exchange('continue', 'still 42', FRESH)
    const blocks = z
      .object({ prompt: z.array(z.object({ text: z.string() })) })
      .parse(next.params).prompt
    expect(blocks[0]?.text).toContain('remember command context 42')
    expect(blocks.at(-1)?.text).toBe('continue')
    expect(
      contextTransferDelivered(readContextTransfers(journalDatabase.db, SESSION), target.id)
    ).toBe(true)
    expect(JSON.stringify(await host.journalSnapshot(SESSION))).not.toContain(
      'orca_context_handoff'
    )
    await host.close(SESSION, 'user-close')
  })

  it.each([
    { input: '  /review src/main', advertised: true },
    { input: '/review\nplease inspect src/main', advertised: true },
    { input: '/review src/main', advertised: false },
    { input: '/deploy staging', advertised: true },
    { input: '/usr/bin/env is the executable I mentioned', advertised: false }
  ])(
    'sends slash-led input $input as typed and leaves saved context owed for the next input',
    async ({ input, advertised }) => {
      const { host, fence, ready, exchange, rig, journalDatabase } = await openRestoreRig(
        -32002,
        'Resource not found'
      )
      expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
      await ready()
      await exchange('remember review context 42', 'saved for review', PROVIDER_SESSION)
      await host.close(SESSION, 'user-close')
      expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
      await ready()
      if (advertised) {
        rig.child().agent.notify('session/update', {
          sessionId: FRESH,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Review changes' }]
          }
        })
        await rig.settle()
        await host.flushStreamedEvents(SESSION)
      }
      const target = currentContextTransferTarget(
        readContextTransfers(journalDatabase.db, SESSION)
      )!
      const command = await exchange(input, 'done', FRESH)
      expect(command.params).toMatchObject({ prompt: [{ type: 'text', text: input }] })
      expect(z.object({ prompt: z.array(z.unknown()) }).parse(command.params).prompt).toHaveLength(
        1
      )
      const afterCommand = readContextTransfers(journalDatabase.db, SESSION)
      expect(afterCommand.some((row) => row.kind === 'delivery')).toBe(false)
      expect(contextTransferDelivered(afterCommand, target.id)).toBe(false)

      const next = await exchange('continue', 'still 42', FRESH)
      const blocks = z
        .object({ prompt: z.array(z.object({ text: z.string() })) })
        .parse(next.params).prompt
      expect(blocks[0]?.text).toContain('remember review context 42')
      expect(blocks.at(-1)?.text).toBe('continue')
      expect(
        contextTransferDelivered(readContextTransfers(journalDatabase.db, SESSION), target.id)
      ).toBe(true)
      await host.close(SESSION, 'user-close')
    }
  )

  it('classifies marked ACP load replays without scanning retained history', async () => {
    const { host, fence, ready, exchange, replays, journalDatabase } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await exchange('remember 42', 'noted', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    await exchange('continue', '42', FRESH)
    const live = readContextTransfers(journalDatabase.db, SESSION).filter(
      (row) => !row.id.startsWith('old-')
    )
    // Each scale replays ten marked items it has not imported before.
    const work = async (closed: number, firstMarker: number) => {
      const retained = seedClosedContextHistories(journalDatabase.db, SESSION, live, closed)
      await host.close(SESSION, 'evict')
      replays.set(FRESH, (agent) => {
        for (let i = firstMarker; i < firstMarker + 10; i++) {
          agent.notify('session/update', {
            sessionId: FRESH,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: {
                type: 'text',
                text: `<orca_context_handoff id="old-D-${i}">\nQuoted ${i}\n</orca_context_handoff>`
              }
            },
            _meta: { isReplay: true, promptId: `prompt:marked-${i}` }
          })
          agent.notify('session/update', {
            sessionId: FRESH,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `reply ${i}` }
            },
            _meta: { isReplay: true, promptId: `prompt:marked-${i}` }
          })
        }
      })
      const facts = instrumentContextTransferFacts(journalDatabase.db)
      const echo = vi.spyOn(contextTransferEcho, 'matchContextTransferEcho')
      expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
      await ready()
      await host.flushStreamedEvents(SESSION)
      const echoes = echo.mock.calls.length
      echo.mockRestore()
      return { retained, echoes, ...facts.counts }
    }
    const small = await work(20, 0)
    const large = await work(200, 10)
    // Reopening loads each retained record once; classifying the replay adds no load or scan.
    for (const counts of [small, large]) {
      expect(counts).toMatchObject({ decodes: counts.retained, loads: 1 })
    }
    expect(small.echoes).toBeGreaterThanOrEqual(10)
    expect(large.echoes).toBe(small.echoes)
    expect(large.kindReads).toBe(small.kindReads)
    expect(large.transferSelects).toBe(small.transferSelects)
    await host.close(SESSION, 'user-close')
  })

  it('accepts a lost carrier reply from exact ACP load replay without exposing its historical prefix', async () => {
    const { host, fence, ready, exchange, rig, replays, messages, journalDatabase } =
      await openRestoreRig(-32002, 'Resource not found')
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await exchange('remember 42', 'remembered', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    await send(host, 'continue exactly once')
    const prompt = await rig.frame('session/prompt')
    const params = z
      .object({ prompt: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(prompt.params)
    await host.close(SESSION, 'evict')
    const records = readContextTransfers(journalDatabase.db, SESSION)
    const delivery = records.find((row) => row.kind === 'delivery' && row.mode === 'inline')
    expect(delivery).toMatchObject({ outcome: { kind: 'unknown' } })
    if (delivery?.kind !== 'delivery') {
      throw new Error('no inline delivery')
    }
    replays.set(FRESH, (agent) => {
      for (const content of params.prompt) {
        agent.notify('session/update', {
          sessionId: FRESH,
          update: { sessionUpdate: 'user_message_chunk', content },
          _meta: { isReplay: true }
        })
      }
      agent.notify('session/update', {
        sessionId: FRESH,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '42' } },
        _meta: { isReplay: true, promptId: promptIdOf(prompt) }
      })
    })
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    await host.flushStreamedEvents(SESSION)
    expect(
      readContextTransfers(journalDatabase.db, SESSION).find((row) => row.id === delivery.id)
    ).toMatchObject({ outcome: { kind: 'inline-accepted' } })
    const snapshot = await host.journalSnapshot(SESSION)
    expect(JSON.stringify(snapshot)).not.toContain('orca_context_handoff')
    expect((await messages()).filter((text) => text === 'continue exactly once')).toHaveLength(1)
    await host.close(SESSION, 'user-close')
  })

  it('preserves the original source and bounds two replacement restarts before the first input', async () => {
    const { host, store, fence, loads, warnings, ready, lost, exchange, journalDatabase } =
      await openRestoreRig(-32002, 'Resource not found')
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    const head = agentSessionProviderHandleChainHead(chain)
    expect(head).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    expect(head?.supersedesKey).toBeUndefined()
    expect(await warnings()).toEqual([])
    await host.close(SESSION, 'user-close')
    lost.set(FRESH, { code: -32002, message: 'Resource not found' })
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(store.getRecord(SESSION)?.providerHandleChain).toHaveLength(2)
    const attempts = readContextTransfers(journalDatabase.db, SESSION).filter(
      (row) => row.kind === 'target'
    )
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({ predecessorTargetId: attempts[0].id, firstInputId: null })
    const prompt = await exchange('hello', 'hello back', FRESH_2)
    expect(JSON.stringify(prompt.params)).not.toContain('orca_context_handoff')
    expect(
      readContextTransfers(journalDatabase.db, SESSION).find((row) => row.id === attempts[1].id)
    ).toMatchObject({ firstInputId: expect.any(String) })
    expect(await warnings()).toEqual([])
    await host.close(SESSION, 'user-close')
  })
})

describe('a replacement after its earlier attach failed to open the journal', () => {
  async function failAttachBeforeReplacement() {
    const opened = await openRestoreRig(-32603, 'session file is corrupt')
    const { host, store, fence, warnings, ready, rig } = opened
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    const spawnedBefore = [...rig.spawned]
    const chainBefore = structuredClone(store.getRecord(SESSION)?.providerHandleChain)
    // Fail before the spawned child's background handshake can prove a replacement link.
    vi.spyOn(AgentSessionJournal.prototype, 'open').mockRejectedValueOnce(
      new Error('journal path unavailable')
    )
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
    expect(rig.spawned).toEqual(spawnedBefore)
    expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(chainBefore)
    expect(
      agentSessionProviderHandleChainHead(store.getRecord(SESSION)?.providerHandleChain ?? [])
    ).toMatchObject({
      handle: { nativeId: PROVIDER_SESSION }
    })
    expect(await warnings()).toEqual([])
    return opened
  }

  it('recovers on the next attach after the journal becomes readable', async () => {
    const { host, fence, loads, warnings, ready } = await failAttachBeforeReplacement()

    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION])
    expect(await warnings()).toHaveLength(0)

    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
  })

  it('retains source provenance when an unused replacement also disappears', async () => {
    const { host, store, fence, loads, lost, warnings, ready } = await failAttachBeforeReplacement()
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    lost.set(FRESH, { code: -32002, message: 'Resource not found' })

    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(2)
    expect(agentSessionProviderHandleChainHead(chain)).toMatchObject({
      handle: { nativeId: FRESH_2 },
      supersedesKey: keyOf(FRESH),
      replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed' }
    })
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH, FRESH_2])
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
  })
})

describe('a replacement Grok never saved, superseded after its row was written', () => {
  it('renders no recovery row across repeated native loss', async () => {
    const { host, fence, loads, lost, warnings, ready } = await openRestoreRig(
      -32603,
      'session file is corrupt'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
    lost.set(FRESH, { code: -32002, message: 'Resource not found' })

    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH])
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([PROVIDER_SESSION, FRESH, FRESH_2])
    expect(await warnings()).toHaveLength(0)
    await host.close(SESSION, 'user-close')
  })
})

describe('saved recovery context across explicit context edits', () => {
  it('retains a pending capture across restatement, rebases kept rewind rows, and closes on clear', async () => {
    const { host, store, fence, ready, exchange, journalDatabase } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await exchange('keep this number 42', 'number saved', PROVIDER_SESSION)
    await exchange('discard this secret 99', 'secret saved', PROVIDER_SESSION)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const before = readContextTransfers(journalDatabase.db, SESSION)
    const source = before.find((row) => row.kind === 'handoff')!
    const replacementItems = journal.snapshot().items.map((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      if (!identity) {
        throw new Error('saved item has no native identity')
      }
      return {
        identity,
        body: item.body,
        observedAt: item.observedAt,
        ownerFence: journal.itemFence(item.itemId) ?? fence(),
        turnScope: item.turnScope
      }
    })
    const oldEpoch = journal.cursor().epoch
    await journal.replaceEpochItems('unreconcilable_prefix', fence(), replacementItems)
    expect(journal.cursor().epoch).not.toBe(oldEpoch)
    expect(readContextTransfers(journalDatabase.db, SESSION)).toEqual(before)

    const kept = replacementItems.filter(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some(
          (block) =>
            block.type === 'text' &&
            (block.text === 'keep this number 42' || block.text === 'number saved')
        )
    )
    expect(kept).toHaveLength(2)
    const rewind = {
      operationId: 'recovery-kept-rewind',
      callerKey: CALLER.callerKey,
      itemId: journal.snapshot().items[0].itemId,
      expectedEpoch: journal.cursor().epoch,
      phase: 'provider-succeeded' as const
    }
    await persistRewindRecord(store, SESSION, fence(), rewind)
    await journal.replaceEpochItems('handle_forked', fence(), kept, (cursor) =>
      store.conversationReceipts.rewind(SESSION, fence(), rewind, cursor)
    )
    const rebased = readContextTransfers(journalDatabase.db, SESSION)
    expect(rebased).toContainEqual(
      expect.objectContaining({
        kind: 'closure',
        handoffId: source.id,
        commandId: rewind.operationId,
        cause: 'rewind'
      })
    )
    const successor = rebased.find((row) => row.kind === 'handoff' && row.id !== source.id)
    expect(successor).toMatchObject({ kind: 'handoff', supersedesHandoffId: source.id })
    if (successor?.kind !== 'handoff') {
      throw new Error('no kept recovery source')
    }
    expect(JSON.stringify(successor.capture)).toContain('keep this number 42')
    expect(JSON.stringify(successor.capture)).not.toContain('discard this secret')

    const clear = envelope(
      'agentSession.conversationCommand',
      { command: 'clear' },
      {
        expectedRuntimeFence: fence()
      }
    )
    expect(
      await host.conversationCommand(CALLER, { command: 'clear', envelope: clear })
    ).toMatchObject({ ok: true, value: { state: 'completed' } })
    const cleared = readContextTransfers(journalDatabase.db, SESSION)
    expect(cleared).toContainEqual(
      expect.objectContaining({
        kind: 'closure',
        handoffId: successor.id,
        cause: 'context-clear',
        commandId: store.getRecord(SESSION)?.providerContextBoundary?.operationId
      })
    )
    expect(currentContextTransferTarget(cleared)).toBeUndefined()
    expect(store.getRecord(SESSION)?.providerHandleChain).toEqual([])
    expect(cleared.find((row) => row.id === source.id)).toEqual(source)
    await host.close(SESSION, 'user-close')
  })
})
