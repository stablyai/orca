import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internals } from '../agent-hooks/server'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { grokBackgroundTaskStop } from './acp-dialects/grok-background-task-stop'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk
} from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send } from './acp-structured-host.test-support'
import { acpChildWorkStatusSink } from './acp-structured-child-work.test-support'

beforeEach(() => _internals.resetCachesForTests())
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

const TASK = '01a10366-1e7f-7191-bcd1-fac24585851f'
const CHILD = `acp-task:${TASK}`

async function fixture() {
  const childWork = acpChildWorkStatusSink()
  const hosted = await openAttachedHostRig({}, childWork.sink)
  cleanup.push(() => hosted.host.close(SESSION, 'user-close'))
  await send(hosted.host, 'Start the dev server')
  const prompt = await hosted.rig.frame('session/prompt')
  const agent = hosted.rig.child().agent
  agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Starting it'))
  await hosted.rows()
  // As the recorded s6-background Grok run sends them.
  const background = async (taskId = TASK, extra: Record<string, unknown> = {}) => {
    agent.notify('_x.ai/task_backgrounded', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'task_backgrounded',
        tool_call_id: 'call-1',
        task_id: taskId,
        command: 'pnpm dev',
        cwd: '/workspace/project',
        output_file: '/workspace/file-1',
        description: 'Run the dev server',
        ...extra
      }
    })
    await hosted.rows()
  }
  const complete = async (snapshot: Record<string, unknown>, taskId = TASK) => {
    agent.notify('_x.ai/task_completed', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'task_completed',
        task_snapshot: {
          task_id: taskId,
          command: 'pnpm dev',
          completed: true,
          kind: 'bash',
          description: 'Run the dev server',
          is_backgrounded: true,
          ...snapshot
        },
        will_wake: false
      }
    })
    await hosted.rows()
  }
  const strip = async () =>
    (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page.backgroundTasks
  const rowState = async () =>
    (await hosted.rows())
      .flatMap((row) =>
        row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
      )
      .find((block) => block.taskId === TASK)?.state
  const targetedStop = (taskId: string) => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' as const, taskId }
    return hosted.host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    })
  }
  const kills = () => agent.frames.filter((frame) => frame.method === '_x.ai/task/kill')
  return {
    ...hosted,
    childWork,
    prompt,
    agent,
    background,
    complete,
    strip,
    rowState,
    targetedStop,
    kills
  }
}

describe('Grok kill reply contract', () => {
  it.each([
    [{ result: { taskId: 'task', outcome: 'killed' } }, 'killed'],
    [{ result: { taskId: 'task', outcome: 'already_exited' } }, 'gone'],
    [{ result: { taskId: 'task', outcome: 'not_found' } }, 'gone'],
    [{ result: null, error: 'session not found' }, 'refused']
  ])('reads %j as %s', (reply, outcome) => {
    expect(grokBackgroundTaskStop.response(reply, 'task')).toBe(outcome)
  })

  it.each([
    { result: { taskId: 'other', outcome: 'killed' } },
    { result: { taskId: 'task', outcome: 'future_outcome' } },
    { result: { taskId: 'task' } },
    { result: null },
    { killed: true }
  ])('rejects a malformed or mismatched reply: %j', (reply) => {
    expect(() => grokBackgroundTaskStop.response(reply, 'task')).toThrow(
      'invalid background task kill response'
    )
  })
})

describe('Grok background commands in the background-tasks strip', () => {
  it('lists a backgrounded command with its own Stop and removes it when Grok says it ended', async () => {
    const f = await fixture()
    await f.background()
    expect(await f.strip()).toMatchObject({
      supportsTaskStop: true,
      supportsStopAll: false,
      tasks: [{ id: CHILD, kind: 'command', description: 'Run the dev server', stoppable: true }]
    })
    expect(f.childWork.views()).toMatchObject([
      { providerId: CHILD, kind: 'command', membership: 'live' }
    ])
    f.agent.reply(f.prompt, { stopReason: 'end_turn' })
    await f.rows()
    expect((await f.strip())?.tasks).toMatchObject([{ id: CHILD }])
    await f.complete({ exit_code: 0 })
    expect(await f.strip()).toBeNull()
    expect(f.childWork.views()).toEqual([])
    expect(await f.rowState()).toBe('done')
  })

  it('lists a monitor as monitoring', async () => {
    const f = await fixture()
    await f.background(TASK, { monitor_description: 'Watch the build log' })
    expect((await f.strip())?.tasks).toMatchObject([
      { id: CHILD, kind: 'monitor', description: 'Watch the build log', stoppable: true }
    ])
    expect(f.childWork.views()).toMatchObject([{ state: 'monitoring' }])
  })

  it("kills only the named task, and the row leaves on Grok's own completion", async () => {
    const f = await fixture()
    await f.background()
    await f.background('sibling-task')
    f.agent.on('_x.ai/task/kill', (frame) =>
      f.agent.reply(frame, { result: { taskId: TASK, outcome: 'killed' } })
    )
    expect(await f.targetedStop(CHILD)).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(f.kills().at(-1)?.params).toEqual({ sessionId: PROVIDER_SESSION, taskId: TASK })
    expect(f.agent.frames.filter((frame) => frame.method === 'session/cancel')).toEqual([])
    expect(f.rig.child().closed).toBe(false)
    // Held until Grok's own ending arrives, so the strip keeps the row in its stopping state.
    expect((await f.strip())?.tasks?.map((task) => task.id)).toEqual([
      CHILD,
      'acp-task:sibling-task'
    ])
    await f.complete({ signal: 'killed', explicitly_killed: true })
    expect((await f.strip())?.tasks?.map((task) => task.id)).toEqual(['acp-task:sibling-task'])
    expect(await f.rowState()).toBe('idle')
  })

  it.each(['already_exited', 'not_found'])(
    'treats %s as gone: the transcript row settles, and a restated live task stays gone',
    async (outcome) => {
      const f = await fixture()
      await f.background()
      f.agent.on('_x.ai/task/kill', (frame) =>
        f.agent.reply(frame, { result: { taskId: TASK, outcome } })
      )
      expect(await f.targetedStop(CHILD)).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(await f.rowState()).toBe('unverifiable')
      expect(await f.strip()).toBeNull()
      expect(f.childWork.views()).toEqual([])
      await f.background()
      expect(await f.rowState()).toBe('unverifiable')
      expect(await f.strip()).toBeNull()
      expect(f.childWork.views()).toEqual([])
    }
  )

  it("still writes Grok's result when its completion follows already_exited", async () => {
    const f = await fixture()
    await f.background()
    f.agent.on('_x.ai/task/kill', (frame) =>
      f.agent.reply(frame, { result: { taskId: TASK, outcome: 'already_exited' } })
    )
    expect(await f.targetedStop(CHILD)).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await f.rowState()).toBe('unverifiable')
    await f.complete({ exit_code: 0 })
    expect(await f.rowState()).toBe('done')
    expect(await f.strip()).toBeNull()
  })

  // As for Codex and Claude: running background work must be stopped before the chat is cleared.
  it('refuses /clear while a background command runs', async () => {
    const f = await fixture()
    await f.background()
    f.agent.reply(f.prompt, { stopReason: 'end_turn' })
    await f.rows()
    const fields = { command: 'clear' as const }
    expect(
      await f.host.conversationCommand(CALLER, {
        ...fields,
        envelope: envelope('agentSession.conversationCommand', fields)
      })
    ).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'Stop background tasks before using this command.',
        details: { reason: 'backgroundTasksRunning' }
      }
    })
  })

  // Grok's own refusal means it killed nothing; a reply about another task proves nothing.
  it.each([
    ['rpc-error', { ok: false, refusal: { code: 'agent_session_operation_invalid' } }],
    ['envelope-error', { ok: false, refusal: { code: 'agent_session_operation_invalid' } }],
    ['mismatched-id', { ok: false, refusal: { code: 'agent_session_operation_unknown' } }]
  ] as const)('keeps the row after a %s', async (failure, answer) => {
    const f = await fixture()
    await f.background()
    f.agent.on('_x.ai/task/kill', (frame) => {
      if (failure === 'rpc-error') {
        f.agent.fail(frame, -32603, 'Internal error')
      } else if (failure === 'envelope-error') {
        f.agent.reply(frame, { result: null, error: 'session actor died' })
      } else {
        f.agent.reply(frame, { result: { taskId: 'other', outcome: 'killed' } })
      }
    })
    expect(await f.targetedStop(CHILD)).toMatchObject(answer)
    expect((await f.strip())?.tasks).toMatchObject([{ id: CHILD, stoppable: true }])
    expect(f.rig.child().closed).toBe(false)
  })
})

describe('Grok kill route check', () => {
  async function checked(answer: (agent: AcpScriptedAgent, frame: FakeFrame) => void) {
    const evidence: AgentChildWorkEvidence[] = []
    const rig = await openAcpAdapterRig({
      script: (agent) => agent.on('_x.ai/task/kill', (frame) => answer(agent, frame)),
      deps: { onChildWorkEvidence: (_session, edges) => evidence.push(...edges) }
    })
    cleanup.push(() => rig.adapter.closeAll())
    await rig.acquire()
    rig.child().agent.notify('_x.ai/task_backgrounded', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'task_backgrounded', task_id: TASK, command: 'pnpm dev' }
    })
    await rig.settle()
    return { rig, evidence }
  }

  it('hides Stop only when Grok names the route unknown, and still lists the command', async () => {
    const { rig, evidence } = await checked((agent, frame) => {
      expect(frame.params).toEqual({})
      agent.fail(frame, -32601, 'Method not found')
    })
    // The session still offers Stop for its subagents, whose route answered.
    expect(rig.adapter.backgroundTaskStops(ADAPTER_SESSION)?.supportsTaskStop).toBe(true)
    expect(evidence).toMatchObject([
      { type: 'live', child: { handle: { id: CHILD }, kind: 'command', stoppable: false } }
    ])
    await expect(
      rig.adapter.stopBackgroundTasks({ sessionId: ADAPTER_SESSION, fence: 1, taskIds: [CHILD] })
    ).rejects.toThrow('unavailable')
    expect(rig.sent('_x.ai/task/kill')).toHaveLength(1)
  })

  it.each([
    [
      'another refusal',
      (agent: AcpScriptedAgent, frame: FakeFrame) => agent.fail(frame, -32603, 'Internal error')
    ],
    ['no answer', () => {}]
  ])('leaves Stop to answer for itself after %s', async (_label, answer) => {
    const { evidence } = await checked(answer)
    expect(evidence).toMatchObject([{ type: 'live', child: { stoppable: true } }])
  })
})
