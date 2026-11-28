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
import { AcpRelayTurns } from '../process/acp-relay-turns'
import { AcpAuthRequiredError } from '../transport/acp-errors'
import { AcpStructuredTurns } from './acp-structured-turns'
import type { AcpDispatchSettlement, AcpSteerMode } from './acp-turn-dispatch-contract'

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
  const trace: string[] = []
  const sink: ProviderTimelineSink = {
    tryAppendTransition: (transition) => {
      steps.push(...transition.steps)
      for (const row of endedTurnRows(transition.steps)) {
        trace.push(`end:${row.turnId}`)
      }
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
    settle: (settlement) => {
      settlements.push(settlement)
      trace.push(
        `settle:${settlement.clientMessageId}:${'state' in settlement ? settlement.state : 'accepted'}`
      )
    },
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
    trace,
    settlements,
    sessionLosses,
    withdrawRequests,
    send: (clientMessageId: string, text: string, mode: AcpSteerMode = 'mail') => {
      turns.dispatch(
        {
          clientMessageId,
          prompt: [{ type: 'text', text }],
          requestedAt: ++clock
        },
        mode
      )
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

function promptText(frame: FakeFrame): string {
  if (typeof frame.params !== 'object' || frame.params === null || !('prompt' in frame.params)) {
    return ''
  }
  const { prompt } = frame.params
  if (!Array.isArray(prompt)) {
    return ''
  }
  return prompt
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof block.text === 'string'
        ? block.text
        : ''
    )
    .join('')
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

    expect(h.prompts.map(promptText)).toEqual(['first', 'second'])
    expect(h.cancels).toHaveLength(0)

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()
    expect(h.prompts.map(promptText)).toEqual(['first', 'second', 'third'])
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
    expect(h.trace.indexOf('settle:m2:rejected')).toBeGreaterThan(-1)
    expect(h.trace.indexOf('settle:m2:rejected')).toBeLessThan(h.trace.indexOf('end:prompt:m1'))
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

  it('steers concurrently for both mail and cancel modes when promptSteers is enabled', async () => {
    const h = await createHarness({ promptSteers: true })
    h.send('m1', 'first', 'cancel')
    await tick()
    h.send('m2', 'manual steer button', 'cancel')
    await tick()

    expect(h.prompts).toHaveLength(2)
    expect(h.cancels).toHaveLength(0)

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()
    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()

    expect(endedTurnRows(h.steps).map((row) => row.turnId)).toEqual(['prompt:m1', 'prompt:m2'])
    expect(h.cancels).toHaveLength(0)
    expect(h.turns.running).toBe(false)
  })

  it('preserves a confirmed out-of-order steering reply during teardown', async () => {
    for (const cause of [undefined, new AcpAuthRequiredError('sign in again')]) {
      const h = await createHarness({ promptSteers: true })
      h.send('m1', 'first')
      h.send('m2', 'confirmed before close')
      await tick()

      // Steer confirms before active yields, then connection tears down before promotion.
      h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
      await tick()
      h.turns.end('connection lost', cause)

      expect(h.settlements).toContainEqual({
        clientMessageId: 'm2',
        providerIdentity: { provider: 'orca', clientMessageId: 'm2' }
      })
      expect(h.turns.running).toBe(false)
    }
  })

  it('waits non-destructively for an adopted earlier prompt before resuming concurrent steering', async () => {
    const h = await createHarness({ promptSteers: true })
    const earlier = Promise.withResolvers<{ stopReason: 'end_turn' }>()
    h.turns.adoptEarlier('m-adopted', () => earlier.promise)
    h.send('m-steer', 'after adopted turn', 'mail')
    await tick()

    // Does not overlap or cancel an adopted pre-restart prompt.
    expect(h.prompts).toHaveLength(0)
    expect(h.cancels).toHaveLength(0)
    expect(h.turns.holdsSteers).toBe(true)

    earlier.resolve({ stopReason: 'end_turn' })
    await tick()
    expect(h.prompts.map(promptText)).toEqual(['after adopted turn'])

    // Once the adopted prompt settles, normal concurrent steering resumes.
    h.send('m-steer-2', 'concurrent follow-up', 'mail')
    await tick()
    expect(h.prompts.map(promptText)).toEqual(['after adopted turn', 'concurrent follow-up'])
    expect(h.cancels).toHaveLength(0)

    h.agent.reply(h.prompts[0], { stopReason: 'end_turn' })
    await tick()
    h.agent.reply(h.prompts[1], { stopReason: 'end_turn' })
    await tick()

    expect(endedTurnRows(h.steps).map((row) => row.turnId)).toEqual([
      'prompt:m-adopted',
      'prompt:m-steer',
      'prompt:m-steer-2'
    ])
    expect(h.turns.running).toBe(false)
  })

  it('preserves next-turn replay floor across concurrent handoff and releases acks on completion', async () => {
    const relay = new AcpRelayTurns()
    const floor = relay.ackFloor()
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const p1 = relay.track(
      (onId) => {
        onId(101)
        return first.promise
      },
      false,
      true
    )
    const p2 = relay.track(
      (onId) => {
        onId(102)
        return second.promise
      },
      false,
      true
    )
    expect(floor.promptId).toBe(101)

    // Steer prompt 2 fails before opening; active prompt 1 must keep the turn floor open.
    second.reject(new Error('invalid steer'))
    await expect(p2).rejects.toThrow('invalid steer')
    expect(floor.promptId).toBe(101)

    // Prompt 3 runs concurrently; prompt 1 answers at seq 2 and prompt 3 emits unnumbered text at seq 3
    // before prompt 1's completion handler runs.
    const third = Promise.withResolvers<string>()
    const p3 = relay.track(
      (onId) => {
        onId(103)
        return third.promise
      },
      false,
      true
    )
    const unnumberedChunk = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: PROVIDER_SESSION_ID,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }
      }
    })
    floor.observe(1, unnumberedChunk)
    floor.observe(
      2,
      JSON.stringify({ jsonrpc: '2.0', id: 101, result: { stopReason: 'end_turn' } })
    )
    floor.observe(3, unnumberedChunk)
    expect(floor.floor(3)).toBe(1)

    first.resolve('done-1')
    await expect(p1).resolves.toBe('done-1')
    expect(floor.promptId).toBe(103)
    // Prompt 3's already-observed unnumbered chunk at seq 3 must stay held by the floor.
    expect(floor.floor(3)).toBe(3)

    floor.observe(
      4,
      JSON.stringify({ jsonrpc: '2.0', id: 103, result: { stopReason: 'end_turn' } })
    )
    third.resolve('done-3')
    await expect(p3).resolves.toBe('done-3')
    // The original floor releases acknowledgements once the final concurrent prompt completes.
    expect(floor.floor(4)).toBeNull()
    const nextFloor = relay.ackFloor()
    expect(nextFloor.promptId).toBeNull()
  })

  it('preserves calls started after batched concurrent prompt answers', async () => {
    const relay = new AcpRelayTurns()
    const floor = relay.ackFloor()
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const p1 = relay.track(
      (onId) => {
        onId(201)
        return first.promise
      },
      false,
      true
    )
    const p2 = relay.track(
      (onId) => {
        onId(202)
        return second.promise
      },
      false,
      true
    )

    const toolCall = (toolCallId: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: PROVIDER_SESSION_ID,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolCallId,
            status: 'in_progress'
          }
        }
      })

    // Both answers and a subsequent call arrive synchronously before either completion runs.
    floor.observe(1, toolCall('call-p1'))
    floor.observe(
      2,
      JSON.stringify({ jsonrpc: '2.0', id: 201, result: { stopReason: 'end_turn' } })
    )
    floor.observe(3, toolCall('call-p2'))
    floor.observe(
      4,
      JSON.stringify({ jsonrpc: '2.0', id: 202, result: { stopReason: 'end_turn' } })
    )
    floor.observe(5, toolCall('call-after-both'))

    first.resolve('done-1')
    second.resolve('done-2')
    await expect(p1).resolves.toBe('done-1')
    await expect(p2).resolves.toBe('done-2')

    // Calls from prompts 201 and 202 clear, while the call after prompt 202's answer stays held.
    expect(floor.floor(5)).toBe(5)
    floor.endCall('call-after-both')
    expect(floor.floor(5)).toBeNull()
  })
})
