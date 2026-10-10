import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CursorStructuredSessionAdapter } from './cursor-structured-session-adapter'
import type { CursorSdkConnection } from './cursor-sdk-connection'
import type { CursorSidecarCommand, CursorSidecarEvent } from './cursor-sdk-protocol'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'cursor_session',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'cursor',
  providerHandle: null
}

function scriptedConnection(
  onCommand: (command: CursorSidecarCommand, emit: (event: CursorSidecarEvent) => void) => void
): CursorSdkConnection & { events: CursorSidecarEvent[] } {
  const listeners = new Set<(event: CursorSidecarEvent) => void>()
  const events: CursorSidecarEvent[] = []
  const emit = (event: CursorSidecarEvent): void => {
    events.push(event)
    for (const listener of listeners) {
      listener(event)
    }
  }
  return {
    pid: 4242,
    events,
    send(command) {
      onCommand(command, emit)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: async () => {
      emit({ type: 'exited', code: 0 })
      return true
    }
  }
}

function recordingSink(): StructuredAgentSessionEventSink & {
  items: { recordId: string; kind: string }[]
  tombstones: string[]
} {
  const items: { recordId: string; kind: string }[] = []
  const tombstones: string[] = []
  return {
    items,
    tombstones,
    appendItem(identity, body) {
      items.push({
        recordId: identity.provider === 'legacy' ? identity.recordId : identity.provider,
        kind: body.kind
      })
    },
    appendTombstone(identity) {
      tombstones.push(identity.provider === 'legacy' ? identity.recordId : identity.provider)
    },
    publish() {}
  }
}

describe('Cursor structured session adapter', () => {
  it('resumes a ready sidecar and journals a streamed turn', async () => {
    const connection = scriptedConnection((command, emit) => {
      if (command.type === 'start') {
        emit({ type: 'ready', agentId: 'agent_1' })
      }
      if (command.type === 'send') {
        emit({ type: 'text', text: 'hello' })
        emit({ type: 'tool', callId: 'call-1', name: 'shell', status: 'completed', result: 'ok' })
        emit({ type: 'result', status: 'finished', durationMs: 12 })
      }
    })
    const sink = recordingSink()
    const spawned: number[] = []
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    const acquired = await adapter.acquire({
      identity: IDENTITY,
      fence: 1,
      spawnToken: 'spawn-1',
      events: sink,
      onSpawned: async (process) => {
        spawned.push(process.pid)
      }
    })
    expect(spawned).toEqual([4242])
    expect(acquired.link.handle).toEqual({
      transport: 'cursor-sdk',
      agent: 'cursor',
      nativeId: 'agent_1'
    })
    const outcome = await adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    expect(outcome).toEqual({ state: 'accepted', providerIdentity: null })
    expect(sink.items.map((item) => item.recordId)).toEqual([
      'turn:turn-1',
      'assistant:turn-1',
      'tool:call-1',
      'turn:turn-1'
    ])
    await expect(adapter.closeSession(IDENTITY.sessionId)).resolves.toBe(true)
  })

  it('refuses a start that never signed in before the sidecar is ready', async () => {
    const connection = scriptedConnection((command, emit) => {
      if (command.type === 'start') {
        emit({ type: 'startupError', message: 'Not signed in', code: 'unauthenticated' })
      }
    })
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    await expect(
      adapter.acquire({ identity: IDENTITY, fence: 1, spawnToken: 'spawn-2' })
    ).rejects.toBeInstanceOf(AgentSessionAcquisitionRefusal)
    await expect(
      adapter.setOption({
        sessionId: IDENTITY.sessionId,
        fence: 1,
        key: 'conversationMode',
        value: 'agent'
      })
    ).rejects.toThrow('Cursor chat cursor_session is not running')
  })

  it('refuses a message whose image cannot be read without leaving a run open', async () => {
    const sent: CursorSidecarCommand['type'][] = []
    const connection = scriptedConnection((command, emit) => {
      sent.push(command.type)
      if (command.type === 'start') {
        emit({ type: 'ready', agentId: 'agent_1' })
      }
      if (command.type === 'send') {
        emit({ type: 'result', status: 'finished', durationMs: 5 })
      }
    })
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    await adapter.acquire({ identity: IDENTITY, fence: 1, spawnToken: 'spawn-image' })
    await expect(
      adapter.dispatch({
        sessionId: IDENTITY.sessionId,
        clientMessageId: 'turn-1',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'image-ref', path: '/tmp/orca-cursor-test-missing-image.png' }]
        },
        fence: 1
      })
    ).rejects.toThrow()
    await expect(
      adapter.dispatch({
        sessionId: IDENTITY.sessionId,
        clientMessageId: 'turn-2',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        fence: 1
      })
    ).resolves.toEqual({ state: 'accepted', providerIdentity: null })
    expect(sent).toEqual(['start', 'send'])
    await expect(adapter.closeSession(IDENTITY.sessionId)).resolves.toBe(true)
  })

  it('steers a follow-up into the running turn', async () => {
    const connection = scriptedConnection((command, emit) => {
      if (command.type === 'start') {
        emit({ type: 'ready', agentId: 'agent_1' })
      }
      if (command.type === 'steer') {
        emit({ type: 'steer', id: command.id, outcome: 'complete_delivered' })
      }
    })
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    await adapter.acquire({ identity: IDENTITY, fence: 1, spawnToken: 'spawn-3' })
    const first = adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    await expect(first).resolves.toMatchObject({ state: 'accepted' })
    const steered = await adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-2',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'also' }] },
      fence: 1
    })
    expect(steered).toEqual({ state: 'accepted', providerIdentity: null })
    await expect(adapter.closeSession(IDENTITY.sessionId)).resolves.toBe(true)
  })

  it('ignores a steer reply after that run has already ended', async () => {
    const steerIds: number[] = []
    let emitEvent: (event: CursorSidecarEvent) => void = () => {}
    const connection = scriptedConnection((command, emit) => {
      emitEvent = emit
      if (command.type === 'start') {
        emit({ type: 'ready', agentId: 'agent_1' })
      }
      if (command.type === 'steer') {
        steerIds.push(command.id)
      }
    })
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    await adapter.acquire({ identity: IDENTITY, fence: 1, spawnToken: 'spawn-steer' })
    await adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    const endedSteer = adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-2',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'also' }] },
      fence: 1
    })
    await vi.waitFor(() => expect(steerIds).toEqual([1]))
    emitEvent({ type: 'result', status: 'finished' })
    await expect(endedSteer).resolves.toMatchObject({ state: 'accepted' })
    let settled = false
    const nextSteer = adapter.dispatch({
      sessionId: IDENTITY.sessionId,
      clientMessageId: 'turn-3',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
      fence: 1
    })
    void nextSteer.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(steerIds).toEqual([1, 2]))
    emitEvent({ type: 'steer', id: 1, outcome: 'complete_delivered' })
    await Promise.resolve()
    expect(settled).toBe(false)
    emitEvent({ type: 'result', status: 'finished' })
    await expect(nextSteer).resolves.toMatchObject({ state: 'accepted' })
  })

  it('closes a sidecar that is still waiting for sign-in when acquire is aborted', async () => {
    let sawStart: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      sawStart = resolve
    })
    let closed = false
    let forced = false
    const connection = scriptedConnection((command) => {
      if (command.type === 'start') {
        sawStart()
      }
    })
    const originalClose = connection.close
    connection.close = async (options) => {
      closed = true
      forced = options?.force === true
      return originalClose()
    }
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    const controller = new AbortController()
    const pending = adapter.acquire({
      identity: IDENTITY,
      fence: 1,
      spawnToken: 'spawn-abort',
      signal: controller.signal
    })
    await started
    controller.abort()
    await expect(pending).rejects.toThrow('Cursor chat was closed while starting')
    expect(closed).toBe(true)
    expect(forced).toBe(true)
  })

  it('removes the sign-in row once the sidecar is ready', async () => {
    const connection = scriptedConnection((command, emit) => {
      if (command.type === 'start') {
        emit({ type: 'loginUrl', url: 'https://cursor.com/login' })
        emit({ type: 'ready', agentId: 'agent_1' })
      }
    })
    const sink = recordingSink()
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      openConnection: () => connection,
      readProcessStartTime: async () => 1000
    })
    await adapter.acquire({
      identity: IDENTITY,
      fence: 1,
      spawnToken: 'spawn-4',
      events: sink
    })
    expect(sink.items.map((item) => item.recordId)).toContain('login-url')
    expect(sink.tombstones).toEqual(['login-url'])
  })

  it('still returns a model when the catalog list fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
    try {
      const connection = scriptedConnection((command, emit) => {
        if (command.type === 'start') {
          emit({ type: 'ready', agentId: 'agent_1' })
        }
      })
      let lists = 0
      const adapter = new CursorStructuredSessionAdapter({
        hostId: 'local',
        stateDirectory: '/tmp/orca-cursor-test',
        resolveWorkspacePath: async () => '/tmp/workspace',
        openConnection: () => connection,
        readProcessStartTime: async () => 1000,
        listModels: async () => {
          lists += 1
          throw new Error('not signed in')
        }
      })
      await adapter.acquire({ identity: IDENTITY, fence: 1, spawnToken: 'spawn-5' })
      await expect(adapter.readOptions({ sessionId: IDENTITY.sessionId })).resolves.toMatchObject({
        current: { model: 'auto', conversationMode: 'agent' }
      })
      await adapter.readOptions({ sessionId: IDENTITY.sessionId })
      expect(lists).toBe(1)
      vi.setSystemTime(new Date('2026-10-07T00:00:01Z'))
      await adapter.readOptions({ sessionId: IDENTITY.sessionId })
      expect(lists).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a model list until the API key changes', async () => {
    let key: string | undefined
    let lists = 0
    const adapter = new CursorStructuredSessionAdapter({
      hostId: 'local',
      stateDirectory: '/tmp/orca-cursor-test',
      resolveWorkspacePath: async () => '/tmp/workspace',
      resolveApiKey: () => key,
      openConnection: () => scriptedConnection(() => {}),
      readProcessStartTime: async () => 1000,
      listModels: async () => {
        lists += 1
        return [{ id: 'composer-2.5', displayName: 'Composer 2.5' }]
      }
    })
    await adapter.readOptions({ sessionId: IDENTITY.sessionId })
    await adapter.readOptions({ sessionId: IDENTITY.sessionId })
    expect(lists).toBe(1)
    key = 'next-key'
    await adapter.readOptions({ sessionId: IDENTITY.sessionId })
    expect(lists).toBe(2)
  })
})
