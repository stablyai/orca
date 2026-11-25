import { afterEach, describe, expect, it, vi } from 'vitest'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { AcpStructuredLane } from '../journal/acp-structured-lane'
import {
  AcpScriptedAgent,
  type FakeFrame,
  tick
} from '../process/testing/acp-scripted-agent.test-support'
import { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { ProviderTimelineSink } from '../../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionTransitionStep } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import { AcpStructuredTurns } from './acp-structured-turns'
import type { AcpDispatchSettlement } from './acp-turn-dispatch-contract'

const SESSION_ID = 'sess-1'
const PROVIDER_SESSION_ID = 'acp-sess-1'
const CANCEL_STEER_DIALECT = { ...ANTIGRAVITY_ACP_DIALECT, promptSteers: undefined }

const harnesses: { lane: AcpStructuredLane; agent: AcpScriptedAgent }[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.lane.dispose()
    harness.agent.close()
  }
})

async function createHarness(options: { promptSteers: boolean }) {
  const agent = new AcpScriptedAgent()
  const prompts: FakeFrame[] = []
  const cancels: FakeFrame[] = []
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: PROVIDER_SESSION_ID }))
  agent.on('session/prompt', (frame) => {
    prompts.push(frame)
  })
  agent.on('session/cancel', (frame) => {
    cancels.push(frame)
  })

  const child = new FakeAcpChild(
    { command: 'agy', args: ['acp'], cwd: '/tmp' },
    { concurrentPrompts: options.promptSteers },
    agent
  )
  await child.start({ cwd: '/tmp', mcpServers: [] })

  const steps: StructuredAgentSessionTransitionStep[] = []
  const sink: ProviderTimelineSink = {
    tryAppendTransition: (transition) => {
      steps.push(...transition.steps)
      transition.onPublished?.()
      return { accepted: true }
    }
  }

  let clock = 1_000
  const settlements: AcpDispatchSettlement[] = []
  const sessionLosses: Error[] = []
  const withdrawRequests = vi.fn()
  let turns!: AcpStructuredTurns

  const lane = new AcpStructuredLane({
    sink,
    sessionId: SESSION_ID,
    agent: 'antigravity',
    agentName: 'Antigravity',
    generation: 'gen-1',
    providerSessionId: PROVIDER_SESSION_ID,
    dialect: options.promptSteers ? ANTIGRAVITY_ACP_DIALECT : CANCEL_STEER_DIALECT,
    logger: createStructuredAgentSessionLogger(),
    now: () => ++clock,
    onInputAccepted: (clientMessageId) => turns.accept(clientMessageId),
    onFailed: (reason) => {
      throw new Error(`lane failed unexpectedly: ${reason}`)
    }
  })

  child.subscribe((event) => {
    lane.apply(lane.translator.sessionEvent(event, ++clock))
  })

  turns = new AcpStructuredTurns({
    connection: child,
    withdrawRequests,
    lane,
    agentName: 'Antigravity',
    dialect: options.promptSteers ? ANTIGRAVITY_ACP_DIALECT : CANCEL_STEER_DIALECT,
    now: () => ++clock,
    settle: (settlement) => settlements.push(settlement),
    sessionLost: (error) => sessionLosses.push(error)
  })

  const harness = {
    agent,
    child,
    lane,
    turns,
    prompts,
    cancels,
    steps,
    settlements,
    sessionLosses,
    withdrawRequests,
    send: (clientMessageId: string, text: string) => {
      turns.dispatch({
        clientMessageId,
        prompt: [{ type: 'text', text }],
        requestedAt: ++clock
      })
    }
  }
  harnesses.push(harness)
  return harness
}

function itemSteps(steps: readonly StructuredAgentSessionTransitionStep[]) {
  return steps.flatMap((step) => (step.kind === 'item' ? [step] : []))
}

function endedTurnRows(steps: readonly StructuredAgentSessionTransitionStep[]) {
  return steps.flatMap((step) => {
    if (
      step.kind !== 'settlement' ||
      step.resolution.kind !== 'timeline-settlement' ||
      !step.resolution.ending ||
      step.resolution.ending.turns === 'running'
    ) {
      return []
    }
    const { end, turns } = step.resolution.ending
    return turns.map((identity) => ({
      turnId:
        identity.provider === 'legacy'
          ? decodeURIComponent(identity.recordId.split(':').at(-1) ?? '')
          : '',
      write: end
    }))
  })
}

function backgroundTaskBlocks(steps: readonly StructuredAgentSessionTransitionStep[]) {
  return itemSteps(steps).flatMap((step) => {
    const body = 'body' in step.resolution ? step.resolution.body : undefined
    return body?.kind === 'message' ? body.blocks.filter(isBackgroundTaskBlock) : []
  })
}

function assistantTextSteps(steps: readonly StructuredAgentSessionTransitionStep[]) {
  return itemSteps(steps).flatMap((step) => {
    if (step.resolution.kind !== 'text-snapshot' || step.resolution.body.role !== 'assistant') {
      return []
    }
    const text = step.resolution.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    return [{ text, turnScope: step.options.turnScope }]
  })
}

describe('AcpStructuredTurns concurrent prompt steering', () => {
  it('steers in place without session/cancel, backgrounds running tools, and opens the steered turn before same-chunk updates', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'start background sleep')
    await tick()
    expect(h.prompts).toHaveLength(1)

    h.agent.notify('session/update', {
      sessionId: PROVIDER_SESSION_ID,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-bg',
        kind: 'execute',
        title: 'sleep 12',
        status: 'in_progress',
        rawInput: { CommandLine: 'sleep 12 && echo BG_DONE' }
      }
    })
    await tick()

    h.send('m2', 'status mail update')
    await tick()

    expect(h.prompts).toHaveLength(2)
    expect(h.cancels).toHaveLength(0)
    expect(h.turns.running).toBe(true)
    expect(h.turns.holdsSteers).toBe(true)
    const pendingM2 = h.turns.capturePendingSend('m2')
    expect(pendingM2()).toBe(true)

    // Write prompt 1's end_turn and prompt 2's first chunk in a single stdout frame chunk.
    const yieldFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: h.prompts[0].id,
      result: { stopReason: 'end_turn' }
    })
    const steeredReplyFrame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: PROVIDER_SESSION_ID,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Ack steer' }
        }
      }
    })
    h.agent.stdout.write(`${yieldFrame}\n${steeredReplyFrame}\n`)
    await tick()

    const turn1End = endedTurnRows(h.steps).find((row) => row.turnId === 'prompt:m1')
    expect(turn1End?.write).toMatchObject({ state: 'completed', outcome: 'success' })

    const backgroundWorking = backgroundTaskBlocks(h.steps).find(
      (block) => block.taskId === 'call-bg' && block.state === 'working'
    )
    expect(backgroundWorking).toMatchObject({ taskId: 'call-bg', state: 'working' })

    // Flush the live assistant text chunk into a committed snapshot.
    h.lane.flush()
    const steerReply = assistantTextSteps(h.steps).find((step) => step.text === 'Ack steer')
    expect(steerReply?.turnScope?.kind).toBe('turn')
    const turnItemId =
      steerReply?.turnScope?.kind === 'turn'
        ? decodeURIComponent(decodeURIComponent(steerReply.turnScope.turnItemId))
        : ''
    expect(turnItemId).toContain('prompt:m2')
    expect(h.lane.openTurnId).toContain('prompt%3Am2')
    expect(h.settlements).toContainEqual({
      clientMessageId: 'm2',
      providerIdentity: { provider: 'orca', clientMessageId: 'm2' }
    })

    // Background tool completes during turn 2 and settles its background task.
    h.agent.notify('session/update', {
      sessionId: PROVIDER_SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-bg',
        status: 'completed',
        rawOutput: { combinedOutput: 'BG_DONE', exitCode: 0 }
      }
    })
    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()

    const backgroundDone = backgroundTaskBlocks(h.steps).find(
      (block) => block.taskId === 'call-bg' && block.state === 'done'
    )
    expect(backgroundDone).toMatchObject({
      taskId: 'call-bg',
      state: 'done',
      summary: 'BG_DONE'
    })
    expect(h.cancels).toHaveLength(0)
    expect(h.turns.running).toBe(false)
    expect(pendingM2()).toBe(false)
  })

  it('caps concurrent wire prompts at two across a burst of three sends and preserves order', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'second')
    h.send('m3', 'third')
    await tick()

    expect(h.prompts).toHaveLength(2)
    expect(h.cancels).toHaveLength(0)

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()
    expect(h.prompts).toHaveLength(3)
    expect(h.cancels).toHaveLength(0)

    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()
    h.agent.reply(h.prompts[2], { stopReason: 'end_turn' })
    await tick()

    const completedTurns = endedTurnRows(h.steps)
      .filter((row) => row.write.state === 'completed')
      .map((row) => row.turnId)
    expect(completedTurns).toEqual(['prompt:m1', 'prompt:m2', 'prompt:m3'])
    expect(h.cancels).toHaveLength(0)
    expect(h.turns.running).toBe(false)
  })

  it('withdraws unstarted steers on Stop while carrying Stop across an already-sent steer', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    await tick()
    h.agent.notify('session/update', {
      sessionId: PROVIDER_SESSION_ID,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        kind: 'execute',
        title: 'sleep 10',
        status: 'in_progress'
      }
    })
    h.send('m2', 'already on wire')
    h.send('m3', 'still queued')
    await tick()

    let idle = false
    const waitIdle = h.turns.whenIdle().then(() => {
      idle = true
    })

    expect(h.turns.stop(5_000)).toBe(true)
    await h.child.cancel()
    await tick()

    expect(h.settlements).toContainEqual(
      expect.objectContaining({ clientMessageId: 'm3', state: 'rejected' })
    )
    expect(h.settlements.some((s) => s.clientMessageId === 'm2')).toBe(false)
    expect(idle).toBe(false)

    // Prompt 1 yields before observing cancel; Stop stays active and re-issues cancel for prompt 2.
    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()

    expect(h.turns.stopped).toBe(true)
    expect(h.turns.running).toBe(true)
    expect(idle).toBe(false)
    expect(h.cancels).toHaveLength(2)

    h.agent.reply(h.prompts[1], { stopReason: 'cancelled' })
    await waitIdle
    await tick()

    expect(h.turns.stopped).toBe(false)
    expect(h.turns.running).toBe(false)
    // Cancelled turns must not background interrupted tool calls.
    expect(backgroundTaskBlocks(h.steps)).toEqual([])
  })

  it('rejects a pre-open steer refusal without disrupting the active prompt and advances the next steer', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'bad steer')
    h.send('m3', 'good steer')
    await tick()
    expect(h.prompts).toHaveLength(2)

    h.agent.fail(h.prompts[1], -32602, 'Invalid prompt')
    await tick()

    expect(h.settlements).toContainEqual(
      expect.objectContaining({ clientMessageId: 'm2', state: 'rejected' })
    )
    expect(h.turns.running).toBe(true)
    expect(h.prompts).toHaveLength(3)

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()
    h.agent.reply(h.prompts[2], { stopReason: 'end_turn' })
    await tick()

    expect(h.turns.running).toBe(false)
    expect(h.settlements).toContainEqual({
      clientMessageId: 'm3',
      providerIdentity: { provider: 'orca', clientMessageId: 'm3' }
    })
  })

  it('settles a refused steer before active end_turn when both frames arrive in one stdout chunk', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'refused steer')
    await tick()
    expect(h.prompts).toHaveLength(2)

    const errorFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: h.prompts[1].id,
      error: { code: -32602, message: 'Invalid prompt' }
    })
    const activeEndFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: h.prompts[0].id,
      result: { stopReason: 'end_turn' }
    })
    h.agent.stdout.write(`${errorFrame}\n${activeEndFrame}\n`)
    await tick()

    expect(h.settlements).toContainEqual(
      expect.objectContaining({ clientMessageId: 'm2', state: 'rejected' })
    )
    expect(endedTurnRows(h.steps).map((row) => row.turnId)).toEqual(['prompt:m1'])
    expect(h.turns.running).toBe(false)
  })

  it('buffers an out-of-order steer reply until the active prompt yields', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'second')
    await tick()

    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()
    expect(h.turns.running).toBe(true)
    expect(h.lane.openTurnId).toContain('prompt%3Am1')

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()

    const completedTurns = endedTurnRows(h.steps)
      .filter((row) => row.write.state === 'completed')
      .map((row) => row.turnId)
    expect(completedTurns).toEqual(['prompt:m1', 'prompt:m2'])
    expect(h.turns.running).toBe(false)
  })

  it('settles an in-flight steer as unknown and queued steers as rejected on teardown', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'in flight')
    h.send('m3', 'queued')
    await tick()

    h.turns.end('connection lost')

    expect(h.settlements).toContainEqual({
      clientMessageId: 'm2',
      state: 'unknown',
      reason: 'connection lost'
    })
    expect(h.settlements).toContainEqual(
      expect.objectContaining({ clientMessageId: 'm3', state: 'rejected' })
    )
    expect(h.turns.running).toBe(false)
  })

  it('carries a permission-transition interrupt onto an already-sent concurrent steer', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first')
    h.send('m2', 'in flight steer')
    await tick()

    h.turns.interruptForPermissionTransition()
    await tick()
    expect(h.cancels).toHaveLength(1)

    h.agent.reply(h.prompts[0], { stopReason: 'cancelled' })
    await tick()
    expect(h.cancels).toHaveLength(2)

    h.agent.reply(h.prompts[1], { stopReason: 'cancelled' })
    await tick()
    expect(h.turns.running).toBe(false)
  })

  it('marks a buffered steer cancelled on permission interrupt without sending a second cancel', async () => {
    const h = await createHarness({ promptSteers: true })
    const promptResult = vi.spyOn(h.lane.translator, 'promptResult')
    h.send('m1', 'first')
    h.send('m2', 'in flight steer')
    await tick()

    h.turns.interruptForPermissionTransition()
    await tick()
    expect(h.cancels).toHaveLength(1)

    // Steer answers end_turn out of order before the active prompt finishes.
    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()
    h.agent.reply(h.prompts[0], { stopReason: 'cancelled' })
    await tick()

    expect(h.cancels).toHaveLength(1)
    expect(h.turns.running).toBe(false)
    expect(promptResult).toHaveBeenCalledWith(
      'm2',
      { stopReason: 'end_turn' },
      expect.any(Number),
      true
    )
  })

  it('keeps cancel-to-steer when promptSteers is disabled', async () => {
    const h = await createHarness({ promptSteers: false })
    h.send('m1', 'first')
    h.send('m2', 'steer')
    await tick()

    expect(h.prompts).toHaveLength(1)
    expect(h.cancels).toHaveLength(1)

    h.agent.reply(h.prompts[0], { stopReason: 'cancelled' })
    await tick()

    expect(h.prompts).toHaveLength(2)
  })
})
