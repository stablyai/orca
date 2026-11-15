import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { tick } from '../process/testing/acp-scripted-agent.test-support'
import type { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { DEVIN_ACP_DIALECT } from '../acp-dialects/devin-dialect'
import {
  GROK,
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
      mayBeUnsaved: async () => false,
      lossKeys: []
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
            mayBeUnsaved: async () => mayBeUnsaved,
            lossKeys: []
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

  it('starts a new session in place of a Devin chat that never sent its first prompt', async () => {
    const rig = await openAcpAdapterRig({
      spec: { ...GROK, dialect: DEVIN_ACP_DIALECT },
      launch: {
        resume: {
          sessionId: 'never-saved',
          key: 'acp:devin:never-saved',
          mayBeUnsaved: async () => true,
          lossKeys: []
        }
      },
      initialize: RESUMES,
      // Recorded from Devin 3000.10.31, which saves a session only on its first prompt.
      script: (agent) =>
        agent.on('session/load', (frame) =>
          agent.fail(frame, -32016, 'Session not found', {
            'cognition.ai/errorKind': 'session_not_found',
            'cognition.ai/retryable': false
          })
        )
    })
    await rig.acquire()
    expect(rig.started().link).toMatchObject({ supersedesKey: 'acp:devin:never-saved' })
    expect(await notRestoredRows(rig)).toEqual([])
  })

  it('fails a reopen while another Devin process holds the session rather than replacing it', async () => {
    const rig = await openAcpAdapterRig({
      spec: { ...GROK, dialect: DEVIN_ACP_DIALECT },
      launch: {
        resume: {
          sessionId: 'saved-1',
          key: 'acp-key-saved-1',
          mayBeUnsaved: async () => false,
          lossKeys: []
        }
      },
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/load', (frame) =>
          agent.fail(
            frame,
            -32015,
            "Session 'saved-1' is already open in another process (PID 79007). Close the other instance before opening it here.",
            {
              'cognition.ai/errorKind': 'session_locked',
              'cognition.ai/retryable': true,
              'cognition.ai/lockHolderPid': 79007
            }
          )
        )
    })
    await rig.acquire()
    expect(rig.openFailure()).toBeDefined()
    expect(rig.sent('session/new')).toEqual([])
  })
})

describe('reopening an OpenCode chat whose conversation the agent moved to another folder', () => {
  it('reopens it in the folder OpenCode lists after a temporary listing failure, starting no new session', async () => {
    let listingFailed = false
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      launch: {
        resume: {
          sessionId: 'ses_moved',
          key: 'acp-key-moved',
          mayBeUnsaved: async () => false,
          lossKeys: []
        }
      },
      initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } },
      script: (agent) => {
        // Captured from OpenCode 2.2.7 after its session_move tool moved the session.
        agent.on('session/load', (frame) => {
          const { cwd } = z.object({ cwd: z.string() }).parse(frame.params)
          if (cwd === '/workspace/project') {
            agent.fail(
              frame,
              -32602,
              'Invalid params: session ses_moved does not belong to cwd: /workspace/project',
              { sessionId: 'ses_moved', cwd: '/workspace/project' }
            )
            return
          }
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
        agent.on('session/list', (frame) => {
          if (!listingFailed) {
            listingFailed = true
            agent.fail(frame, -32603, 'Internal service failure', {
              errorName: 'ServiceUnavailableError'
            })
            return
          }
          agent.reply(frame, {
            sessions: [
              { sessionId: 'ses_other', cwd: '/workspace/project' },
              { sessionId: 'ses_moved', cwd: '/workspace/project-worktree' }
            ]
          })
        })
      }
    })
    await rig.acquire()
    expect(rig.sent('session/load').map((frame) => frame.params)).toMatchObject([
      { sessionId: 'ses_moved', cwd: '/workspace/project' },
      { sessionId: 'ses_moved', cwd: '/workspace/project-worktree' }
    ])
    expect(rig.sent('session/new')).toHaveLength(0)
    expect(rig.started().link).toMatchObject({
      origin: 'resumed',
      handle: { nativeId: 'ses_moved' }
    })
    expect(rig.started().link?.replaces).toBeUndefined()
    expect(await notRestoredRows(rig)).toHaveLength(0)
  })
})

describe('temporary saved-session restore failures', () => {
  it.each(['load', 'resume'] as const)(
    'keeps the saved session after exhausted %s retries and restores options and sending on retry',
    async (method) => {
      let recovering = false
      let failedRecovery = false
      const requests: string[] = []
      const rig = await openAcpAdapterRig({
        ...resume,
        spec: { ...GROK, resumePreference: method === 'resume' ? 'resume' : undefined },
        initialize: RESUMES,
        script: (agent) => {
          agent.on('session/new', (frame) => {
            requests.push('session/new')
            agent.reply(frame, { sessionId: 'replacement' })
          })
          agent.on(`session/${method}`, (frame) => {
            requests.push(`session/${method}`)
            if (method === 'load') {
              agent.notify('session/update', {
                sessionId: PROVIDER_SESSION,
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: { type: 'text', text: 'saved question' }
                },
                _meta: { promptId: 'saved-turn', isReplay: true }
              })
              agent.notify(
                'session/update',
                replyChunk('saved-turn', 'saved answer', { isReplay: true })
              )
            }
            if (!recovering || !failedRecovery) {
              failedRecovery = recovering
              agent.fail(frame, -32603, 'Internal service failure', {
                errorName: 'ServiceUnavailableError'
              })
            } else {
              agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
            }
          })
        }
      })
      await rig.acquire()
      expect(rig.openVerdict()).toMatchObject({ retry: 'never', fact: { kind: 'startFailed' } })
      expect(requests).toEqual([`session/${method}`, `session/${method}`, `session/${method}`])
      expect(await texts(rig)).toEqual([])
      expect(await notRestoredRows(rig)).toEqual([])

      recovering = true
      await rig.acquire({ fence: 2 })
      expect(rig.openVerdict()).toBeUndefined()
      expect(rig.started().link).toMatchObject({
        origin: 'resumed',
        handle: { nativeId: 'acp-session-1' }
      })
      expect(rig.started().link?.replaces).toBeUndefined()
      expect(rig.started().catalogListing?.models.map((model) => model.id)).toEqual([
        'grok-4.7',
        'grok-4.6'
      ])
      expect(await texts(rig)).toEqual(method === 'load' ? ['saved question', 'saved answer'] : [])
      expect(requests).toEqual([
        `session/${method}`,
        `session/${method}`,
        `session/${method}`,
        `session/${method}`,
        `session/${method}`
      ])
      expect(await sendHello(rig, 'after-retry', 2)).toMatchObject({ state: 'admitted' })
      const prompt = await rig.frame('session/prompt')
      expect(prompt.params).toMatchObject({ sessionId: 'acp-session-1' })
      rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
      await rig.settle()
      expect(await notRestoredRows(rig)).toEqual([])
    }
  )

  it('sends no further restore or new-session request after abort during backoff', async () => {
    const controller = new AbortController()
    const requests: string[] = []
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) => {
        agent.on('session/new', (frame) => {
          requests.push('session/new')
          agent.reply(frame, { sessionId: 'replacement' })
        })
        agent.on('session/load', (frame) => {
          requests.push('session/load')
          agent.fail(frame, -32603, 'Internal service failure', {
            errorName: 'ServiceUnavailableError'
          })
        })
      }
    })
    const opening = rig.acquire({ signal: controller.signal })
    await rig.frame('session/load')
    await tick()
    controller.abort()
    await opening
    expect(requests).toEqual(['session/load'])
    expect(await texts(rig)).toEqual([])
  })
})
