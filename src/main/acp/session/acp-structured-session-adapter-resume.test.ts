import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

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

/** Replay history, end the prior process's stale task, and report context usage. */
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

/** Grok saved the exchange only once the chat sent it: the first open has nothing to replay. */
function onReopen(): (replay: () => void) => void {
  let loads = 0
  return (replay) => {
    if (loads++ > 0) {
      replay()
    }
  }
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
  it('leaves a reply cut off mid-turn as it was cut, never completed from what Grok saved', async () => {
    const reopen = onReopen()
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          reopen(() => sendsWhileAttaching(agent, 'complete saved reply'))
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

  it.each([
    ['a saved session', false, -32603, 'session file is corrupt'],
    ['a created session that fails for another reason', true, -32603, 'session file is corrupt'],
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
      await rig.acquire()
      expect(rig.started().link).toMatchObject({
        origin: 'created',
        handle: { nativeId: PROVIDER_SESSION },
        replaces: { key: 'acp-key-saved-1', reason: 'restore-failed', replacedAt: 5_000 }
      })
      expect(rig.started().link?.supersedesKey).toBeUndefined()
      expect(rig.sent('session/new')).toHaveLength(1)
      const rows = await notRestoredRows(rig)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.body).toMatchObject({ kind: 'status', tone: 'warning' })
      await exchange(rig, 'hi', true)
      expect(await texts(rig)).toEqual(['hello', 'hi'])
      expect(await notRestoredRows(rig)).toHaveLength(1)
    }
  )
})
