import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ZcodeAppServerRequestError } from './zcode-app-server-request-error'
import {
  adapterFor,
  acquireInput,
  fakeZcode,
  identityFor,
  PROVIDER_SESSION
} from './zcode-structured-adapter-fixture'

const messageBody = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

describe('ZcodeStructuredSessionAdapter.acquire', () => {
  it('creates a conversation and publishes the child with its snapshot id', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)

    const acquisition = await adapter.acquire(acquireInput())

    expect(zcode.connections).toHaveLength(1)
    expect(zcode.connections[0]!.requests).toEqual([
      {
        method: 'session/create',
        params: { workspace: { workspacePath: '/work/repo', workspaceKey: '/work/repo' } }
      },
      {
        method: 'session/subscribe',
        params: { sessionId: PROVIDER_SESSION, deliveryKind: 'desktop-continuous' }
      }
    ])
    expect(acquisition.process).toEqual({
      hostId: 'local',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link.handle).toEqual({
      transport: 'zcode-app-server',
      agent: 'zcode',
      nativeId: PROVIDER_SESSION
    })
    expect(acquisition.link.origin).toBe('created')
    expect(acquisition.link.mintedAtFence).toBe(7)
  })

  it('reports the same process identity to onSpawned as the acquisition carries', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)
    const spawned: unknown[] = []

    const acquisition = await adapter.acquire(
      acquireInput({
        onSpawned: async (process) => {
          spawned.push(process)
        }
      })
    )

    expect(spawned).toEqual([acquisition.process])
  })

  it('binds the sink reading control so queue pressure can pause the child stream', async () => {
    const zcode = fakeZcode()
    const bound: unknown[] = []
    const unbind = vi.fn()
    const adapter = adapterFor(zcode, [], {
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const sink = {
      bindReadingControl: vi.fn((control: unknown) => {
        bound.push(control)
        return unbind
      })
    }

    // SAFETY: the acquire path only touches `bindReadingControl` on this sink.
    await adapter.acquire(
      acquireInput({ events: sink as unknown as StructuredAgentSessionEventSink })
    )

    expect(sink.bindReadingControl).toHaveBeenCalledOnce()
    expect(bound[0]).toMatchObject({ pauseReading: expect.any(Function) })
  })

  it('routes a live permission prompt into the session and the journal', async () => {
    const zcode = fakeZcode()
    const items: unknown[] = []
    const adapter = adapterFor(zcode)
    const sink = {
      appendItem: vi.fn((_identity: unknown, body: unknown) => {
        items.push(body)
      }),
      publish: vi.fn()
    }
    // SAFETY: the acquire path only touches translator wiring on this sink.
    await adapter.acquire(
      acquireInput({ events: sink as unknown as StructuredAgentSessionEventSink })
    )

    const connection = zcode.connections[0]!
    connection.handlers.onServerRequest?.({
      id: 11,
      method: 'interaction/requestPermission',
      params: {
        requestId: 'perm-1',
        sessionId: PROVIDER_SESSION,
        toolName: 'bash',
        reason: 'wants to run ls',
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny', kind: 'deny', name: 'Deny' }
        ]
      }
    })

    const outcome = await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'zcode-prompt-11',
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow' },
      fence: 7,
      commit: async () => {}
    })
    expect(outcome).toBeUndefined()
    expect(connection.replies).toEqual([{ id: 11, result: { decision: 'allow' } }])
    expect(sink.appendItem).toHaveBeenCalledOnce()
    expect(items[0]).toMatchObject({
      kind: 'approval',
      title: 'Allow bash?',
      detail: 'wants to run ls',
      resolution: { state: 'pending' }
    })
  })

  it('restores snapshot messages that file their id inside info', async () => {
    const zcode = fakeZcode({
      'session/resume': () => ({
        session: { sessionId: PROVIDER_SESSION },
        messages: [
          { info: { role: 'user', messageId: 'm1' }, parts: [{ type: 'text', text: 'earlier' }] }
        ]
      })
    })
    const adapter = adapterFor(zcode, [], {
      resolveLaunch: async () => ({
        command: 'zcode',
        args: ['app-server', '--stdio'],
        cwd: '/work/repo',
        zcodeHome: null,
        resumeSessionId: PROVIDER_SESSION,
        workspacePath: '/work/repo'
      })
    })

    await adapter.acquire(acquireInput())

    // The resumed conversation seeded its history: the session answer over the
    // journal names the snapshot rows, whatever shape carried the id.
    expect(zcode.connections[0]!.requests[0]!.method).toBe('session/resume')
  })

  it('resumes the conversation the record proved, never one the caller names', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode, [], {
      resolveLaunch: async () => ({
        command: 'zcode',
        args: ['app-server', '--stdio'],
        cwd: '/work/repo',
        zcodeHome: '/home/dev/.zcode',
        resumeSessionId: PROVIDER_SESSION,
        workspacePath: '/work/repo'
      })
    })

    const acquisition = await adapter.acquire(acquireInput())

    expect(zcode.connections[0]!.requests).toEqual([
      { method: 'session/resume', params: { sessionId: PROVIDER_SESSION } },
      {
        method: 'session/subscribe',
        params: { sessionId: PROVIDER_SESSION, deliveryKind: 'desktop-continuous' }
      }
    ])
    expect(acquisition.link.handle.nativeId).toBe(PROVIDER_SESSION)
    expect(acquisition.link.origin).toBe('resumed')
  })

  it('refuses a resume that minted a different conversation', async () => {
    const zcode = fakeZcode({
      'session/resume': () => ({ session: { sessionId: 'sess_other' }, messages: [] })
    })
    const adapter = adapterFor(zcode, [], {
      resolveLaunch: async () => ({
        command: 'zcode',
        args: ['app-server', '--stdio'],
        cwd: '/work/repo',
        zcodeHome: null,
        resumeSessionId: PROVIDER_SESSION,
        workspacePath: '/work/repo'
      })
    })

    await expect(adapter.acquire(acquireInput())).rejects.toThrow(
      /resumed session sess_other when asked for/
    )
    expect(zcode.connections[0]!.closeCount).toBe(1)
  })

  it('closes the child when the create never answers', async () => {
    const zcode = fakeZcode({
      'session/create': () => new Promise<never>(() => {})
    })
    const adapter = adapterFor(zcode, [], { requestTimeoutMs: 100 })

    await expect(adapter.acquire(acquireInput())).rejects.toThrow()
    expect(zcode.connections[0]!.closeCount).toBe(1)
  })
})

describe('ZcodeStructuredSessionAdapter.dispatch', () => {
  it('accepts a send the provider took', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)
    await adapter.acquire(acquireInput())

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: messageBody('hello'),
      fence: 7
    })

    expect(outcome).toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: 'zcode',
        sessionId: '',
        recordId: 'message:client-1'
      }
    })
    expect(zcode.connections[0]!.requests[2]).toEqual({
      method: 'session/send',
      params: { sessionId: PROVIDER_SESSION, content: 'hello' }
    })
  })

  it('rejects a send the provider refused, quoting its words', async () => {
    const zcode = fakeZcode({
      'session/send': () => {
        throw new ZcodeAppServerRequestError('session/send', -32010, 'busy', 'a turn is running')
      }
    })
    const adapter = adapterFor(zcode)
    await adapter.acquire(acquireInput())

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: messageBody('hello'),
      fence: 7
    })

    expect(outcome.state).toBe('rejected')
  })

  it('leaves a timed-out send unsettled', async () => {
    const zcode = fakeZcode({
      'session/send': () => new Promise<never>(() => {})
    })
    const adapter = adapterFor(zcode, [], { requestTimeoutMs: 50 })
    await adapter.acquire(acquireInput())

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: messageBody('hello'),
        fence: 7
      })
    ).rejects.toThrow()
  })
})

describe('ZcodeStructuredSessionAdapter.cancelTurn', () => {
  it('stops the provider turn', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)
    await adapter.acquire(acquireInput())

    const outcome = await adapter.cancelTurn({
      sessionId: 'session-1',
      turnId: 't1',
      fence: 7
    })

    expect(outcome).toEqual({ cancelled: true, turnId: 't1' })
    expect(zcode.connections[0]!.requests[2]).toEqual({
      method: 'session/stop',
      params: { sessionId: PROVIDER_SESSION }
    })
  })

  it('refuses a stop for a session that is not live', async () => {
    const adapter = adapterFor(fakeZcode())
    expect(await adapter.cancelTurn({ sessionId: 'nope', fence: 7 })).toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
  })
})

describe('ZcodeStructuredSessionAdapter close', () => {
  it('closes the child and reports the end as requested', async () => {
    const zcode = fakeZcode()
    const events: {
      type: 'ended'
      sessionId: string
      reason: string
      cause: string
      fence: number
      acquisitionGeneration: string
      observedAt?: number
    }[] = []
    const adapter = adapterFor(zcode, events)
    await adapter.acquire(acquireInput())

    expect(await adapter.closeSession('session-1')).toBe(true)

    expect(events).toEqual([
      expect.objectContaining({ type: 'ended', sessionId: 'session-1', cause: 'requested-close' })
    ])
    expect(zcode.connections[0]!.closeCount).toBe(1)
  })

  it('reports an unexpected exit through the connection observer', async () => {
    const zcode = fakeZcode()
    const events: {
      type: 'ended'
      sessionId: string
      reason: string
      cause: string
      fence: number
      acquisitionGeneration: string
      observedAt?: number
    }[] = []
    const adapter = adapterFor(zcode, events)
    await adapter.acquire(acquireInput({ identity: identityFor('session-9') }))

    // Simulate the child dying with no close asked.
    const connection = zcode.connections[0]!
    connection.handlers.onExit?.(new Error('zcode app-server connection ended: crashed'), {
      expected: false
    })

    expect(events).toEqual([
      expect.objectContaining({ type: 'ended', sessionId: 'session-9', cause: 'unexpected-exit' })
    ])
  })

  it('answers a setOption for the model key and refuses anything else', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)
    await adapter.acquire(acquireInput())

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    ).rejects.toThrow(/no session option named effort/)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'glm-5', fence: 7 })
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'glm-5'
    })
  })
})
