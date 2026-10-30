import { PassThrough } from 'node:stream'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createAcpAgentConnection, type AcpAgentConnection } from './acp-agent-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  openHostRig,
  attachParams,
  send,
  promptIdOf,
  launch
} from './acp-structured-host.test-support'
import {
  CALLER,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { activeProviderContext } from '../../shared/agent-session-provider-context'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import { afterEach, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  openAcpAdapterRig,
  replyChunk,
  sendHello,
  GROK_CONFIG_OPTIONS,
  PROVIDER_SESSION
} from './acp-structured-adapter.test-support'

const teardown = vi.hoisted(() => vi.fn<typeof terminateProviderProcessTree>())
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))
const actual = await vi.importActual<{
  terminateProviderProcessTree: typeof terminateProviderProcessTree
}>('../provider-process/provider-process-teardown')

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

it.each(['delivered', 'root-exited', 'unproven', 'error'] as const)(
  'owns detached lane/sink cleanup with old raw-stop outcome parity: %s',
  async (outcome) => {
    const entries =
      outcome === 'error'
        ? ['raw-stop', 'sink-refusal', 'sink-without-logger']
        : ['raw-stop', 'sink-refusal']
    for (const entry of entries) {
      const fallback = entry === 'sink-without-logger'
      const warn = fallback ? vi.spyOn(console, 'warn').mockImplementation(() => {}) : null
      const logger = { warn: vi.fn(), error: vi.fn() }
      const rig = await openAcpAdapterRig({ deps: fallback ? {} : { logger } })
      let refuse = false
      const append = rig.rig.eventSink.tryAppendTransition!
      vi.spyOn(rig.rig.eventSink, 'tryAppendTransition').mockImplementation((transition) =>
        refuse ? { accepted: false, reason: 'closed' } : append(transition)
      )
      await rig.acquire()
      const child = rig.child()
      const terminal = outcome === 'delivered' || outcome === 'root-exited'
      Object.defineProperty(child, 'lastCloseResult', {
        value: {
          root: outcome === 'root-exited' ? 'exited' : 'live',
          tree: 'unverifiable',
          ...(outcome === 'delivered' ? { killDelivered: true } : {})
        }
      })
      const failure = new Error('genuine cleanup failure')
      child.proveClose = vi.fn(async () => {
        if (outcome === 'error') {
          throw failure
        }
        if (outcome === 'root-exited') {
          child.processTreeUnproven = true
          child.exit()
        }
        return terminal
      })
      if (entry === 'raw-stop') {
        if (outcome === 'error') {
          await expect(rig.adapter['children'].stop(SESSION, false)).rejects.toBe(failure)
        } else {
          expect(await rig.adapter['children'].stop(SESSION, false)).toBe(terminal)
        }
      } else {
        const sending = sendHello(rig, 'sink-failure').catch(() => undefined)
        const frame = await rig.frame('session/prompt')
        refuse = true
        child.agent.notify(
          'session/update',
          replyChunk(promptIdOf(frame), 'output that cannot be journaled')
        )
        await vi.waitFor(() => expect(child.proveClose).toHaveBeenCalled())
        await rig.settle()
        await sending
        if (outcome === 'error' && fallback) {
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('acp-child-cleanup'),
            expect.objectContaining({ error: failure })
          )
        } else if (outcome === 'error') {
          expect(logger.warn).toHaveBeenCalledWith(
            'ACP failed-child cleanup failed',
            expect.objectContaining({ error: failure })
          )
        } else {
          expect(logger.warn).not.toHaveBeenCalledWith(
            'ACP failed-child cleanup failed',
            expect.anything()
          )
        }
      }
      expect(rig.ended).toHaveLength(terminal ? 1 : 0)
      if (outcome === 'delivered') {
        expect(rig.ended[0]).toMatchObject({ deathEvidenceKind: 'kill-delivered' })
      }
      if (terminal) {
        await rig.acquire({ fence: 2 })
        expect(rig.spawned.filter((value) => value === 'spawn')).toHaveLength(2)
      }
      child.proveClose = async () => {
        child.exit()
        return true
      }
      await rig.adapter.closeAll()
    }
  }
)

it('keeps joined force-close typed delivery evidence', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  Object.defineProperty(rig.child(), 'lastCloseResult', {
    value: { root: 'live', tree: 'unverifiable', killDelivered: true }
  })
  rig.child().proveClose = async () => true
  await expect(rig.adapter.forceCloseSession(SESSION)).rejects.toBeInstanceOf(
    AgentSessionAcquisitionRootExitObservedError
  )
})

it.each([true, false])(
  'composes actual source failure and delivered kill, initially accepted=%s, through host release/reopen/successor',
  async (initiallyAccepted) => {
    const children: ReturnType<typeof createFakePipedChild>[] = []
    const agents: AcpScriptedAgent[] = []
    const connections: AcpAgentConnection[] = []
    const inputComplete = vi.fn()
    let allowed = initiallyAccepted
    let delivered = 0
    teardown.mockImplementation((child, deps) =>
      actual.terminateProviderProcessTree(child, {
        ...deps,
        captureDescendants: async () => ({
          rootPgid: null,
          capturedAtMs: 1,
          descendants: [
            {
              pid: child.pid! + 1,
              ppid: child.pid!,
              pgid: child.pid! + 1,
              startedAt: 'Mon Jan 1 00:00:00 2026'
            }
          ]
        }),
        terminateDescendants: async () => 'unverifiable',
        signalProcessGroup: () => {
          if (!allowed) {
            throw Object.assign(new Error('writer group unavailable'), { code: 'ESRCH' })
          }
          delivered++
        },
        signalProcess: () => {},
        terminateWindowsTree: async () => {
          if (allowed) {
            delivered++
          }
          return allowed
        }
      })
    )
    const f = await openHostRig({
      deps: {
        resolveLaunch: launch(() => children.length > 0),
        connect: (launch, handlers) => {
          const agent = new AcpScriptedAgent()
          const child = Object.assign(createFakePipedChild(9_999_900 + children.length * 10), {
            stdin: agent.stdin,
            stdout: agent.stdout,
            stderr: new PassThrough()
          })
          agent.on('initialize', (frame) =>
            agent.reply(frame, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
          )
          agent.on('session/new', (frame) =>
            agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS })
          )
          agent.on('session/load', (frame) =>
            agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
          )
          for (const method of ['_x.ai/subagent/cancel', '_x.ai/task/kill']) {
            agent.on(method, (frame) =>
              agent.fail(frame, -32602, 'Invalid params', 'missing field')
            )
          }
          if (children.length > 0) {
            agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
            child.stdin.once('finish', () => {
              child.emit('exit', 0, null)
              child.stdout.end()
            })
          }
          const connection = createAcpAgentConnection(
            launch,
            {
              ...handlers,
              onInputComplete: (error) => {
                inputComplete(error)
                handlers.onInputComplete?.(error)
              }
            },
            () => child
          )
          children.push(child)
          agents.push(agent)
          connections.push(connection)
          return connection
        }
      }
    })
    const sessionId = HOST_TEST_SESSION
    expect(await f.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await f.ready()
    const cursor = f.host.collaboratorsForTests().sessions.get(sessionId)!.journal.cursor()
    const sent = await send(f.host, 'original request')
    await vi.waitFor(() =>
      expect(agents[0].frames.some((frame) => frame.method === 'session/prompt')).toBe(true)
    )
    const frame = agents[0].frames.find((entry) => entry.method === 'session/prompt')!
    const meta = { promptId: promptIdOf(frame) }
    const update = (value: unknown) =>
      agents[0].notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: value,
        _meta: meta
      })
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'received-tool',
      title: 'echo complete',
      kind: 'execute',
      status: 'in_progress'
    })
    connections[0].pauseReading()
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'received-tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'whole final startup output' } }]
    })
    const original = new Error('resident ACP source failed')
    const old = f.host.collaboratorsForTests().sessions.get(sessionId)!.child!
    const events = vi.spyOn(f.host, 'handleAdapterEvent')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    children[0].stdout.emit('error', original)
    const receipt = f.rig.adapter.forceCloseSession(sessionId).catch((error: unknown) => error)
    const advance = () =>
      vi.advanceTimersByTimeAsync(
        (process.platform === 'win32'
          ? ROOT_ONLY_GRACEFUL_EXIT_MS
          : PROVIDER_SUPERVISOR_MAX_STOP_MS) + 1000
      )
    await advance()
    if (!initiallyAccepted) {
      expect(await receipt).toBe(false)
      expect(connections[0].exited).toBe(false)
      expect(f.rig.adapter.hasOwnedAcquisition(sessionId)).toBe(true)
      expect(f.store.getRecord(sessionId)?.lease.claimStatus).not.toBe('released')
      const replacement = f.rig.adapter
        .acquire({
          identity: {
            sessionId,
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'grok',
            providerHandle: null
          },
          fence: old.fence + 1,
          spawnToken: 'blocked'
        })
        .catch((error: unknown) => error)
      await advance()
      expect(await replacement).toMatchObject({ name: 'AgentSessionAcquisitionExitUnprovenError' })
      expect(children).toHaveLength(1)
      allowed = true
    }
    const report = initiallyAccepted
      ? await receipt
      : (() => {
          const retry = f.rig.adapter.forceCloseSession(sessionId).catch((error: unknown) => error)
          return advance().then(() => retry)
        })()
    const accepted = await report
    expect(accepted).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect(accepted).toMatchObject({ deathEvidenceKind: 'kill-delivered', cause: original })
    await f.host.flushStreamedEvents(sessionId)
    await vi.waitFor(() =>
      expect(f.store.getRecord(sessionId)?.lease).toMatchObject({
        claimStatus: 'released',
        deathEvidence: { kind: 'kill-delivered', ownerFence: old.fence }
      })
    )
    expect(connections[0].exited).toBe(false)
    expect(children[0].exitCode).toBeNull()
    expect(inputComplete).toHaveBeenCalledOnce()
    expect(inputComplete).toHaveBeenCalledWith(original)
    expect(delivered).toBe(1)
    await expect(connections[0].close()).rejects.toBe(original)
    expect(events.mock.calls.filter(([event]) => event.type === 'ended')).toHaveLength(1)
    expect(f.rig.adapter.hasOwnedAcquisition(sessionId)).toBe(false)
    expect(
      (await f.host.journalSnapshot(sessionId)).submissions.find(
        (row) => row.clientMessageId === sent
      )?.dispatchState
    ).not.toBe('pending')
    const database = JournalHostDatabase.open(hostTestState().root)
    const reopened = new AgentSessionJournal({
      database,
      identity: {
        sessionId,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: activeProviderContext(f.store.getRecord(sessionId)!).head!.handle
      }
    })
    try {
      await reopened.open()
      const replay = reopened.readSince(cursor)
      if (!replay.ok) {
        throw new Error('resident source prefix was not replayable')
      }
      expect(
        replay.rows.flatMap((row) =>
          row.kind === 'item' && row.body.kind === 'tool-call'
            ? [{ itemId: row.itemId, state: row.body.state }]
            : []
        )
      ).toEqual([
        {
          itemId:
            'legacy:grok:session-alpha:item%3Ap%3Aacp-session-1%3Aacp-session-1%2Ftool%253Areceived-tool',
          state: 'running'
        },
        {
          itemId:
            'legacy:grok:session-alpha:item%3Ap%3Aacp-session-1%3Aacp-session-1%2Ftool%253Areceived-tool',
          state: 'completed'
        }
      ])
      const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
      expect(tools.map((row) => row.itemId)).toEqual([
        'legacy:grok:session-alpha:item%3Ap%3Aacp-session-1%3Aacp-session-1%2Ftool%253Areceived-tool'
      ])
      expect(tools[0].body).toMatchObject({
        callId: 'received-tool',
        state: 'completed',
        output: {
          head: 'whole final startup output',
          byteLength: 26,
          digest: '853cbca8ac59bb40c8f14dbc62a6bc03637a9c60de9406383d668eeb7ef95edd',
          truncated: false
        }
      })
    } finally {
      await reopened.close()
      database.close()
    }
    vi.useRealTimers()
    const successor = await send(f.host, 'healthy successor')
    await f.ready()
    await vi.waitFor(async () =>
      expect(
        (await f.host.journalSnapshot(sessionId)).submissions.find(
          (row) => row.clientMessageId === successor
        )
      ).toMatchObject({ dispatchState: 'accepted' })
    )
    expect(children).toHaveLength(2)
    expect(f.store.getRecord(sessionId)?.lease.runtimeFence).toBeGreaterThan(old.fence)
    await f.host.close(sessionId, 'user-close')
    expect(inputComplete).toHaveBeenCalledTimes(2)
  }
)
