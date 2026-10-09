import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFakeSpawnedChild } from '../../shared/child-process/__fixtures__/fake-spawned-child'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import { createAcpAgentConnection } from './acp-agent-connection'
import { AcpScriptedAgent, deferred, type FakeFrame } from './acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  PROVIDER_SESSION,
  replyChunk
} from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send, stop } from './acp-structured-host.test-support'
import { readAcpFixture } from './acp-timeline-fixture.test-support'
import { acpChildWorkStatusSink } from './acp-structured-child-work.test-support'

const teardown = vi.hoisted(() => vi.fn<typeof terminateProviderProcessTree>())
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

const STOP_AT = 1791471985147
const TURN_ANSWER_AFTER_STOP_MS = 129
const EXIT_AFTER_STOP_MS = 2373
const timestamp = z.object({ _meta: z.object({ agentTimestampMs: z.number() }) })

async function stoppingChild(reportsOutcome: boolean) {
  const agent = new AcpScriptedAgent()
  const stderr = new PassThrough()
  const child = Object.assign(createFakeSpawnedChild(9_999_999), {
    stdin: agent.stdin,
    stdout: agent.stdout,
    stderr,
    stdio: [agent.stdin, agent.stdout, stderr, null, null] satisfies ReturnType<
      typeof spawnProcess
    >['stdio']
  })
  const spawn = vi.fn<typeof spawnProcess>(() => child)
  // Teardown is simulated: no signal or process-table operation can reach the machine.
  teardown.mockImplementation(async () => {
    child.emit('exit', 0, null)
    return 'exited'
  })
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  )
  agent.on('_x.ai/subagent/cancel', (frame) =>
    agent.fail(frame, -32602, 'Invalid params', 'invalid params: missing field `subagentId`')
  )
  agent.on('session/new', (frame) =>
    agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS })
  )
  const childWork = acpChildWorkStatusSink()
  const hosted = await openAttachedHostRig(
    {
      connect: (launch, options) => createAcpAgentConnection(launch, options, spawn),
      now: () => Date.now()
    },
    childWork.sink
  )
  cleanup.push(async () => {
    child.emit('exit', 0, null)
    await hosted.host.close(SESSION, 'user-close')
  })
  const pendingPrompt = deferred<FakeFrame>()
  agent.on('session/prompt', (frame) => pendingPrompt.resolve(frame))
  await send(hosted.host, 'Run the finite background child')
  const prompt = await pendingPrompt.promise
  const frames = await readAcpFixture('s7-subagent-stop-shutdown')
  const notices = frames.map(({ message }) => ({
    method: message.method ?? '',
    params: JSON.parse(
      JSON.stringify(message.params).replaceAll('prompt:recorded-stop', promptIdOf(prompt))
    ),
    at: timestamp.parse(message.params)._meta.agentTimestampMs
  }))
  const [spawned, turnEnded, finished] = notices
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(spawned.at)
  agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Child running'))
  agent.notify(spawned.method, spawned.params)
  agent.notify('_x.ai/session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'subagent_progress', subagent_id: 'subagent-1', tokens_used: 1721 }
  })
  const rosters = async () =>
    (await hosted.rows()).flatMap((row) =>
      row.body.kind === 'message'
        ? row.body.blocks.filter(isSubagentGroupBlock).map((group) => ({ row, group }))
        : []
    )
  const original = (await rosters())[0]
  vi.setSystemTime(STOP_AT)
  const closeAt: number[] = []
  child.stdin.once('finish', () => closeAt.push(Date.now()))
  agent.on('session/cancel', () => {
    setTimeout(() => agent.notify(turnEnded.method, turnEnded.params), turnEnded.at - STOP_AT)
    setTimeout(() => agent.reply(prompt, { stopReason: 'cancelled' }), TURN_ANSWER_AFTER_STOP_MS)
    if (reportsOutcome) {
      setTimeout(() => agent.notify(finished.method, finished.params), finished.at - STOP_AT)
    }
    setTimeout(() => child.emit('exit', 0, null), EXIT_AFTER_STOP_MS)
  })
  expect(await stop(hosted.host)).toMatchObject({ ok: true, value: { cancelled: true } })
  return { ...hosted, child, agent, original, rosters, finished, closeAt, childWork }
}

describe('Grok child outcome during a full host Stop', () => {
  it('journals the recorded cancellation after the parent ends and stdin closes, before exit', async () => {
    const fixture = await stoppingChild(true)
    await vi.advanceTimersByTimeAsync(TURN_ANSWER_AFTER_STOP_MS)
    expect(fixture.closeAt).toEqual([STOP_AT + TURN_ANSWER_AFTER_STOP_MS])
    expect((await fixture.turns()).at(-1)).toMatchObject({ state: 'interrupted' })
    expect((await fixture.rosters())[0].group.agents[0].state).toBe('working')
    expect(fixture.childWork.views()).toMatchObject([
      { membership: 'live', providerId: 'subagent-1' }
    ])
    await vi.advanceTimersByTimeAsync(233 - TURN_ANSWER_AFTER_STOP_MS)
    const [cancelled] = await fixture.rosters()
    expect(cancelled.row.itemId).toBe(fixture.original.row.itemId)
    expect(cancelled.row.turnScope).toEqual(fixture.original.row.turnScope)
    expect(cancelled.group.agents).toEqual([
      {
        ...fixture.original.group.agents[0],
        state: 'stopped',
        settledAt: STOP_AT + 233
      }
    ])
    await vi.advanceTimersByTimeAsync(EXIT_AFTER_STOP_MS - 233)
    expect(fixture.childWork.views()).toMatchObject([
      { membership: 'settled', outcome: 'cancelled' }
    ])
    expect((await fixture.rosters())[0].group).toEqual(cancelled.group)
    const settled = await fixture.rows()
    fixture.agent.notify(fixture.finished.method, fixture.finished.params)
    expect(await fixture.rows()).toEqual(settled)
    await fixture.host.close(SESSION, 'user-close')
  })

  it('leaves the child unverifiable when shutdown supplies no authoritative outcome', async () => {
    const fixture = await stoppingChild(false)
    await vi.advanceTimersByTimeAsync(EXIT_AFTER_STOP_MS)
    const [unavailable] = await fixture.rosters()
    expect(fixture.childWork.views()).toMatchObject([{ membership: 'settled', outcome: 'unknown' }])
    expect(unavailable.row.itemId).toBe(fixture.original.row.itemId)
    expect(unavailable.group.agents).toEqual([
      { ...fixture.original.group.agents[0], state: 'unverifiable' }
    ])
    fixture.agent.notify(fixture.finished.method, fixture.finished.params)
    expect((await fixture.rosters())[0].group).toEqual(unavailable.group)
    await fixture.host.close(SESSION, 'user-close')
  })
})
