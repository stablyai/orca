import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { ACP_REOPEN_FAILED } from './acp-session-reopen-failure'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

/** Grok's own capabilities: it loads and resumes sessions; Orca reopens with `session/load`. */
const RESUMES = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }
const resume = {
  launch: {
    resume: {
      sessionId: PROVIDER_SESSION,
      key: 'acp:grok:saved',
      mayBeUnsaved: () => false,
      unannouncedLosses: () => []
    }
  }
}

/** Everything Grok may send while it reattaches: its saved exchange marked as replay, a task the
 *  dead process left running ended by the restart, and its context usage. */
function sendsWhileAttaching(agent: AcpScriptedAgent, reply: string): void {
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
    _meta: { isReplay: true }
  })
  agent.notify('session/update', replyChunk('prompt:m1', reply, { isReplay: true }))
  agent.notify('x.ai/task_completed', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 'task-orphan', command: 'sleep 600', signal: 'session_restart' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'usage_update', used: 4_000, size: 200_000 }
  })
}

/** Orca's send of `hello` as `m1` and Grok's reply, ended or cut off. */
async function exchange(rig: AcpAdapterRig, reply: string, end: boolean): Promise<void> {
  await rig.rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
    turnScope: { kind: 'thread' }
  })
  await sendHello(rig, 'm1')
  const prompt = await rig.frame('session/prompt')
  rig.child().agent.notify('session/update', replyChunk('prompt:m1', reply))
  if (end) {
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  }
  await rig.settle()
}

const texts = async (rig: AcpAdapterRig) =>
  (await rig.rig.rows()).flatMap((row) => messageText(row.body) ?? [])

const notRestoredRows = async (rig: AcpAdapterRig) =>
  (await rig.rig.rows()).filter(
    (row) =>
      row.body.kind === 'status' &&
      readAgentSessionFailureFact(row.body.failure)?.kind === 'sessionNotRestored'
  )

/** What Grok might send while it resumes with no replay mark: an old reply and its turn's end. */
function sendsUnmarkedWhileAttaching(agent: AcpScriptedAgent): void {
  agent.notify('session/update', replyChunk('prompt:old', 'stale text'))
  agent.notify('x.ai/session_notification', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt:old', stop_reason: 'end_turn' }
  })
}

describe('the reattach window', () => {
  const resumesUnmarked = {
    ...resume,
    initialize: RESUMES,
    script: (agent: AcpScriptedAgent) =>
      agent.on('session/load', (frame) => {
        sendsUnmarkedWhileAttaching(agent)
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      })
  }

  it('writes nothing Grok sends while it loads, even unmarked as replay', async () => {
    const rig = await openAcpAdapterRig(resumesUnmarked)
    await rig.acquire()
    await rig.settle()
    expect(await rig.rig.rows()).toEqual([])
  })

  it('leaves no turn from the window for a later Stop to find', async () => {
    const rig = await openAcpAdapterRig({
      ...resumesUnmarked,
      script: (agent: AcpScriptedAgent) =>
        agent.on('session/load', (frame) => {
          // An old reply with no end and no replay mark.
          agent.notify('session/update', replyChunk('prompt:old', 'stale text'))
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
    expect(rig.child().closes).toBe(0)
  })
})

describe('the context meter across a reopen', () => {
  it('keeps the last reading the journal holds; the load only refreshes the window', async () => {
    const models = {
      currentModelId: 'grok-4.7',
      availableModels: [
        { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256_000 } }
      ]
    }
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        // A load that replays no usage; its answer carries only the models.
        agent.on('session/load', (frame) =>
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS, models })
        )
    })
    await rig.acquire()
    await sendHello(rig, 'm1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk('prompt:m1', 'hi'))
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'usage_update', used: 4_000, size: 200_000 }
    })
    agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    const usage = (await rig.rig.rows())
      .flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      .at(-1)?.contextUsage
    expect(usage).toMatchObject({
      window: { tokens: 256_000 },
      used: { usage: { inputTokens: 4_000 } }
    })
  })
})

describe('reattaching a Grok chat the journal holds', () => {
  it('loads with session/load though Grok also resumes, and writes nothing it replays', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    const before = (await rig.rig.rows()).map((row) => row.itemId)
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(rig.sent('session/load')).toHaveLength(1)
    expect(rig.sent('session/resume')).toHaveLength(0)
    // No second user bubble, no stale task row, and no turn opened by the load's own traffic.
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before)
    expect(await texts(rig)).toEqual(['hello', 'hi'])
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 2 })).resolves.toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
  })

  it('loads an agent that only loads, writing none of what it replays', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    const before = await rig.rig.rows()
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(rig.sent('session/resume')).toHaveLength(0)
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before.map((row) => row.itemId))
    expect(await texts(rig)).toEqual(['hello', 'hi'])
  })

  it('leaves a reply cut off mid-turn as it was cut, never completed from what Grok saved', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'complete saved reply')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'complete', false)
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    const rows = await rig.rig.rows()
    expect(await texts(rig)).toEqual(['hello', 'complete'])
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).toEqual([
      'unverifiable'
    ])
  })

  it('writes nothing of the reattach into a sink the host binds only after the start', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    await rig.adapter.closeSession(SESSION)
    const before = await rig.rig.rows()
    // The host's order: a fresh sink per start, bound to the journal once the start succeeded.
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
    await rig.adapter.acquire({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: null
      },
      fence: 2,
      spawnToken: 'spawn-2',
      events: deferred.sink
    })
    deferred.bind({ journal: rig.rig.journal, fence: 2, publish: () => {} })
    expect(await deferred.drained()).toMatchObject({ ok: true })
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before.map((row) => row.itemId))
    await rig.adapter.closeSession(SESSION)
    deferred.close()
  })

  it.each([
    ['reports missing', -32002, 'Resource not found'],
    ['fails for another reason', -32603, 'session file is corrupt']
  ])(
    'starts a new session in place of a created one session/load %s',
    async (_label, code, message) => {
      const rig = await openAcpAdapterRig({
        launch: {
          resume: {
            sessionId: 'never-saved',
            key: 'acp:grok:never-saved',
            mayBeUnsaved: () => true,
            unannouncedLosses: () => []
          }
        },
        initialize: RESUMES,
        script: (agent) => agent.on('session/load', (frame) => agent.fail(frame, code, message))
      })
      const acquired = await rig.acquire()
      expect(acquired.link).toMatchObject({
        origin: 'created',
        handle: { nativeId: PROVIDER_SESSION },
        supersedesKey: 'acp:grok:never-saved'
      })
      expect(acquired.link.replaces).toBeUndefined()
      // The failed load left the translator taking prompts.
      await exchange(rig, 'hi', true)
      expect(await texts(rig)).toEqual(['hello', 'hi'])
      // Nothing was forgotten: the agent never saved that session.
      expect(await notRestoredRows(rig)).toEqual([])
    }
  )

  it.each([
    ['a saved session', false, -32603, 'session file is corrupt'],
    ['a saved session the agent reports missing', false, -32002, 'Resource not found']
  ])(
    'continues %s it cannot reopen in a new one, says so once, and keeps working',
    async (_label, mayBeUnsaved, code, message) => {
      const rig = await openAcpAdapterRig({
        launch: {
          resume: {
            sessionId: 'saved-1',
            key: 'acp-key-saved-1',
            mayBeUnsaved: () => mayBeUnsaved,
            unannouncedLosses: () => []
          }
        },
        initialize: RESUMES,
        script: (agent) => agent.on('session/load', (frame) => agent.fail(frame, code, message))
      })
      const acquired = await rig.acquire()
      expect(acquired.link).toMatchObject({
        origin: 'created',
        handle: { nativeId: PROVIDER_SESSION },
        replaces: { key: 'acp-key-saved-1', reason: 'restore-failed', replacedAt: 5_000 }
      })
      expect(acquired.link.supersedesKey).toBeUndefined()
      expect(rig.sent('session/new')).toHaveLength(1)
      const rows = await notRestoredRows(rig)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.body).toMatchObject({ kind: 'status', tone: 'warning' })
      await exchange(rig, 'hi', true)
      expect(await texts(rig)).toEqual(['hello', 'hi'])
      expect(await notRestoredRows(rig)).toHaveLength(1)
    }
  )

  it('refuses a signed-out agent at reopen rather than replacing its session', async () => {
    const rig = await openAcpAdapterRig({
      launch: {
        resume: {
          sessionId: 'saved-1',
          key: 'acp-key-saved-1',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      },
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/load', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    })
    const failure = await rig.acquire().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(failure).toMatchObject({ reason: 'notSignedIn' })
    expect(rig.sent('session/new')).toEqual([])
  })

  it('fails a start closed while the agent reopens rather than opening a new session', async () => {
    const start = new AbortController()
    const logger = { warn: vi.fn(), error: vi.fn() }
    const rig = await openAcpAdapterRig({
      launch: {
        resume: {
          sessionId: 'saved-1',
          key: 'acp-key-saved-1',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      },
      initialize: RESUMES,
      deps: { logger },
      script: (agent) =>
        agent.on('session/load', (frame) => {
          start.abort()
          agent.fail(frame, -32603, 'session file is corrupt')
        })
    })
    expect(
      await rig.acquire({ signal: start.signal }).catch((error: unknown) => error)
    ).toBeInstanceOf(Error)
    expect(rig.sent('session/new')).toEqual([])
    expect(await notRestoredRows(rig)).toEqual([])
    // Nothing was replaced, so nothing says it was.
    expect(logger.warn).not.toHaveBeenCalledWith(ACP_REOPEN_FAILED, expect.anything())
  })

  it('keeps the slash commands Grok reports while it loads', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'compact', description: 'Compress', input: null }]
            }
          })
          agent.reply(frame, { configOptions: [] })
        })
    })
    await rig.acquire()
    await rig.settle()
    expect(rig.adapter.readCommands(SESSION)).toEqual([
      { name: 'compact', kind: 'command', description: 'Compress' }
    ])
  })
})
