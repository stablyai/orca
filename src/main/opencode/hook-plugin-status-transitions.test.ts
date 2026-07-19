import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock }
}))

import { _internals } from './hook-service'

type SessionFixture = { id: string; parentID?: string }
type PluginEvent = { type: string; properties?: Record<string, unknown> }
type PluginEventHandler = (input: { event: PluginEvent }) => Promise<void>
type PluginHooks = { event: PluginEventHandler; dispose?: () => Promise<void> }
type RecordedPost = Record<string, unknown> & { hook_event_name: string }

const ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'] as const

describe('OpenCode plugin status transitions', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-status-plugin-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)).payload as RecordedPost)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = savedFetch
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function loadHooks(
    sessions: SessionFixture[],
    list?: () => Promise<{ data: SessionFixture[] }>,
    get?: (input: Record<string, unknown>) => Promise<{ data?: SessionFixture }>
  ): Promise<PluginHooks> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<PluginHooks>
    }
    const hooks = await module.OrcaOpenCodeStatusPlugin({
      client: {
        session: {
          list: list ?? (async () => ({ data: sessions })),
          ...(get ? { get } : {})
        }
      }
    })
    return hooks
  }

  async function loadHandler(
    sessions: SessionFixture[],
    list?: () => Promise<{ data: SessionFixture[] }>,
    get?: (input: Record<string, unknown>) => Promise<{ data?: SessionFixture }>
  ): Promise<PluginEventHandler> {
    return (await loadHooks(sessions, list, get)).event
  }

  function status(sessionID: string, type: 'busy' | 'idle' | 'retry'): PluginEvent {
    return { type: 'session.status', properties: { sessionID, status: { type } } }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  function messageUpdated(
    sessionID: string,
    messageID: string,
    role: 'assistant' | 'user'
  ): PluginEvent {
    return {
      type: 'message.updated',
      properties: { sessionID, info: { id: messageID, role } }
    }
  }

  function messagePart(sessionID: string, messageID: string, text: string): PluginEvent {
    return {
      type: 'message.part.updated',
      properties: { sessionID, part: { type: 'text', messageID, text } }
    }
  }

  function questionToolPart(
    sessionID: string,
    messageID: string,
    callID: string,
    status: 'completed' | 'error'
  ): PluginEvent {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: { type: 'tool', tool: 'question', sessionID, messageID, callID, state: { status } }
      }
    }
  }

  function sessionError(sessionID: string, name: string, message: string): PluginEvent {
    return {
      type: 'session.error',
      properties: { sessionID, error: { name, data: { message } } }
    }
  }

  it('returns to working as soon as permissions and questions resolve', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'root' } }
    })
    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'per_1', sessionID: 'root', reply: 'once' }
      }
    })
    await handler({
      event: { type: 'question.asked', properties: { id: 'que_1', sessionID: 'root' } }
    })
    await handler({
      event: {
        type: 'question.rejected',
        properties: { requestID: 'que_1', sessionID: 'root' }
      }
    })

    expect(names()).toEqual([
      'SessionBusy',
      'PermissionRequest',
      'SessionBusy',
      'AskUserQuestion',
      'SessionBusy'
    ])
  })

  it.each(['completed', 'error'] as const)(
    'restores working when a question tool reaches %s without a reply event',
    async (toolStatus) => {
      const handler = await loadHandler([{ id: 'root' }])

      await handler({ event: status('root', 'busy') })
      await handler({
        event: {
          type: 'question.asked',
          properties: {
            id: 'que_tool',
            sessionID: 'root',
            tool: { messageID: 'msg_tool', callID: 'call_tool' }
          }
        }
      })
      await handler({ event: questionToolPart('root', 'msg_tool', 'call_tool', toolStatus) })

      expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy'])
    }
  )

  it('matches an exact tool call and preserves another concurrent question', async () => {
    const handler = await loadHandler([{ id: 'root' }])
    await handler({ event: status('root', 'busy') })
    for (const [id, callID] of [
      ['que_a', 'call_a'],
      ['que_b', 'call_b']
    ]) {
      await handler({
        event: {
          type: 'question.asked',
          properties: { id, sessionID: 'root', tool: { messageID: 'msg_tool', callID } }
        }
      })
    }

    await handler({ event: questionToolPart('root', 'msg_tool', 'wrong_call', 'completed') })
    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'AskUserQuestion'])

    await handler({ event: questionToolPart('root', 'msg_tool', 'call_a', 'completed') })
    expect(names().at(-1)).toBe('AskUserQuestion')
    expect(posts.at(-1)?.id).toBe('que_b')

    await handler({ event: questionToolPart('root', 'msg_tool', 'call_b', 'completed') })
    expect(names().at(-1)).toBe('SessionBusy')
  })

  it('resolves a child question without treating child lifecycle as root lifecycle', async () => {
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: {
        type: 'question.asked',
        properties: {
          id: 'que_child_tool',
          sessionID: 'child',
          tool: { messageID: 'msg_child', callID: 'call_child' }
        }
      }
    })
    await handler({ event: questionToolPart('child', 'msg_child', 'call_child', 'completed') })
    await handler({ event: status('child', 'busy') })
    await handler({ event: status('child', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('keeps attention visible until every pending request is resolved', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    for (const id of ['per_1', 'per_2']) {
      await handler({
        event: { type: 'permission.asked', properties: { id, sessionID: 'root' } }
      })
    }
    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'per_1', sessionID: 'root', reply: 'once' }
      }
    })

    expect(names()).toEqual([
      'SessionBusy',
      'PermissionRequest',
      'PermissionRequest',
      'PermissionRequest'
    ])
    expect(posts.at(-1)?.id).toBe('per_2')

    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'per_2', sessionID: 'root', reply: 'once' }
      }
    })
    expect(names()).toEqual([
      'SessionBusy',
      'PermissionRequest',
      'PermissionRequest',
      'PermissionRequest',
      'SessionBusy'
    ])
  })

  it('rolls descendant attention up to the root and filters child activity', async () => {
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_child', sessionID: 'child' } }
    })
    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'per_child', sessionID: 'child', reply: 'once' }
      }
    })
    await handler({
      event: { type: 'question.asked', properties: { id: 'que_child', sessionID: 'child' } }
    })
    await handler({
      event: {
        type: 'question.replied',
        properties: { requestID: 'que_child', sessionID: 'child', answers: [['yes']] }
      }
    })
    await handler({ event: status('child', 'busy') })
    await handler({ event: messageUpdated('child', 'message-child', 'assistant') })
    await handler({ event: messagePart('child', 'message-child', 'child reply') })
    await handler({ event: status('child', 'idle') })
    await handler({
      event: { type: 'session.error', properties: { sessionID: 'child', error: { name: 'Error' } } }
    })

    expect(names()).toEqual([
      'SessionBusy',
      'PermissionRequest',
      'SessionBusy',
      'AskUserQuestion',
      'SessionBusy'
    ])
    expect(posts[1].sessionID).toBe('root')
    expect(posts[3].sessionID).toBe('root')
  })

  it('keeps retry working and dedupes canonical plus deprecated idle', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({ event: status('root', 'retry') })
    await handler({ event: status('root', 'idle') })
    await handler({ event: { type: 'session.idle', properties: { sessionID: 'root' } } })

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('tracks blockers independently while matching OpenCode permission priority', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'same-id', sessionID: 'root' } }
    })
    await handler({
      event: { type: 'question.asked', properties: { id: 'same-id', sessionID: 'root' } }
    })
    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'same-id', sessionID: 'root', reply: 'once' }
      }
    })

    expect(names()).toEqual([
      'SessionBusy',
      'PermissionRequest',
      'PermissionRequest',
      'AskUserQuestion'
    ])

    await handler({
      event: {
        type: 'question.replied',
        properties: { requestID: 'same-id', sessionID: 'root', answers: [['yes']] }
      }
    })
    expect(names().at(-1)).toBe('SessionBusy')
  })

  it('clears only the idle child request when another child still needs attention', async () => {
    const handler = await loadHandler([
      { id: 'root' },
      { id: 'child-a', parentID: 'root' },
      { id: 'child-b', parentID: 'root' }
    ])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_a', sessionID: 'child-a' } }
    })
    await handler({
      event: { type: 'question.asked', properties: { id: 'que_b', sessionID: 'child-b' } }
    })
    await handler({ event: status('child-a', 'idle') })

    expect(names().at(-1)).toBe('AskUserQuestion')
    expect(posts.at(-1)?.id).toBe('que_b')

    await handler({
      event: {
        type: 'question.replied',
        properties: { requestID: 'que_b', sessionID: 'child-b', answers: [['yes']] }
      }
    })
    expect(names().at(-1)).toBe('SessionBusy')
  })

  it('flushes the retained root preview when child idle silently aborts its request', async () => {
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_child', sessionID: 'child' } }
    })
    await handler({ event: messageUpdated('root', 'message-root', 'assistant') })
    await handler({ event: messagePart('root', 'message-root', 'retained final preview') })
    await handler({ event: status('child', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'PermissionRequest', 'MessagePart'])
    expect(posts.at(-1)?.text).toBe('retained final preview')
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('surfaces unknown-lineage attention while ignoring unknown lifecycle', async () => {
    const handler = await loadHandler([])

    await handler({ event: status('not-listed-yet', 'busy') })
    await handler({
      event: {
        type: 'question.asked',
        properties: { id: 'que_unknown', sessionID: 'not-listed-yet' }
      }
    })

    expect(names()).toEqual(['AskUserQuestion'])
    expect(posts[0].sessionID).toBe('not-listed-yet')
  })

  it('clears a root request on idle when abort emits no reply event', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'root' } }
    })
    await handler({ event: status('root', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'PermissionRequest', 'SessionIdle'])
  })

  it('keeps a child request live when the root idles and flushes its retained preview later', async () => {
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_child', sessionID: 'child' } }
    })
    await handler({ event: messageUpdated('root', 'message-root', 'assistant') })
    await handler({ event: messagePart('root', 'message-root', 'final answer') })
    await handler({ event: status('root', 'idle') })

    expect(names().includes('MessagePart')).toBe(false)
    expect(names().includes('SessionIdle')).toBe(false)
    expect(names().at(-1)).toBe('PermissionRequest')

    await handler({
      event: {
        type: 'permission.replied',
        properties: { requestID: 'per_child', sessionID: 'child', reply: 'once' }
      }
    })

    expect(names().slice(-2)).toEqual(['MessagePart', 'SessionIdle'])
    expect(posts.at(-2)?.text).toBe('final answer')
  })

  it('clears descendant requests when their root aborts without child cleanup events', async () => {
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'question.asked', properties: { id: 'que_child', sessionID: 'child' } }
    })
    await handler({ event: sessionError('root', 'MessageAbortedError', 'Stopped by user') })
    await handler({ event: status('root', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionAborted'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('keeps active-root resume metadata current across concurrent roots', async () => {
    const handler = await loadHandler([{ id: 'root-a' }, { id: 'root-b' }])

    await handler({ event: status('root-a', 'busy') })
    await handler({ event: status('root-b', 'busy') })
    await handler({ event: messageUpdated('root-a', 'message-a', 'assistant') })
    await handler({ event: messagePart('root-a', 'message-a', 'reply-a') })
    await handler({ event: status('root-a', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'MessagePart', 'SessionBusy'])
    expect(posts.map((post) => post.sessionID)).toEqual(['root-a', 'root-b', 'root-a', 'root-b'])

    await handler({ event: status('root-b', 'idle') })
    expect(names().at(-1)).toBe('SessionIdle')
    expect(posts.at(-1)?.sessionID).toBe('root-b')
  })

  it('keeps a recoverable error invisible when the root continues before idle', async () => {
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({ event: sessionError('root', 'ContextOverflowError', 'Compacting context') })
    await handler({
      event: { type: 'session.error', properties: { error: { name: 'PluginError' } } }
    })

    expect(names()).toEqual(['SessionBusy'])

    // OpenCode starts the post-compaction processor with another busy event.
    await handler({ event: status('root', 'busy') })
    await handler({ event: status('root', 'idle') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('classifies abort and fatal errors only when their root becomes idle', async () => {
    const handler = await loadHandler([{ id: 'aborted' }, { id: 'failed' }])

    await handler({ event: status('aborted', 'busy') })
    await handler({ event: sessionError('aborted', 'MessageAbortedError', 'Stopped by user') })
    expect(names()).toEqual(['SessionBusy'])
    await handler({ event: status('aborted', 'idle') })

    await handler({ event: status('failed', 'busy') })
    await handler({ event: sessionError('failed', 'ProviderAuthError', 'Token expired') })
    expect(names().at(-1)).toBe('SessionBusy')
    await handler({ event: status('failed', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'SessionAborted', 'SessionBusy', 'SessionError'])
    expect(posts[1]).toMatchObject({
      sessionID: 'aborted',
      error: { name: 'MessageAbortedError', data: { message: 'Stopped by user' } }
    })
    expect(posts[3]).toMatchObject({
      sessionID: 'failed',
      error: { name: 'ProviderAuthError', data: { message: 'Token expired' } }
    })
  })

  it('keeps another busy root authoritative before surfacing a terminal error', async () => {
    const handler = await loadHandler([{ id: 'failed' }, { id: 'still-busy' }])

    await handler({ event: status('failed', 'busy') })
    await handler({ event: status('still-busy', 'busy') })
    await handler({ event: sessionError('failed', 'APIError', 'Provider unavailable') })
    await handler({ event: status('failed', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('still-busy')

    await handler({ event: status('still-busy', 'idle') })
    expect(names().at(-1)).toBe('SessionError')
    expect(posts.at(-1)?.sessionID).toBe('failed')
  })

  it('does not resurrect a delivered error after another root succeeds', async () => {
    const handler = await loadHandler([{ id: 'failed' }, { id: 'succeeded' }])

    await handler({ event: status('failed', 'busy') })
    await handler({ event: sessionError('failed', 'APIError', 'Provider unavailable') })
    await handler({ event: status('failed', 'idle') })
    await handler({ event: status('succeeded', 'busy') })
    await handler({ event: status('succeeded', 'idle') })

    expect(names()).toEqual(['SessionBusy', 'SessionError', 'SessionBusy', 'SessionIdle'])
    expect(posts.at(-1)?.sessionID).toBe('succeeded')
  })

  it('preserves event order across an asynchronous session lookup', async () => {
    let releaseFirstList: (() => void) | undefined
    const firstList = new Promise<void>((resolve) => {
      releaseFirstList = resolve
    })
    let calls = 0
    const sessions = [{ id: 'root' }]
    const handler = await loadHandler(sessions, async () => {
      calls += 1
      if (calls === 1) {
        await firstList
      }
      return { data: sessions }
    })

    const busy = handler({ event: status('root', 'busy') })
    const idle = handler({ event: status('root', 'idle') })
    await Promise.resolve()
    releaseFirstList?.()
    await Promise.all([busy, idle])

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('resolves lineage with point lookups when the list page omits the root', async () => {
    const sessions = [{ id: 'root' }, { id: 'child', parentID: 'root' }]
    const byID = new Map(sessions.map((session) => [session.id, session]))
    const get = vi.fn(async (input: Record<string, unknown>) => {
      const path = input.path as { id?: string } | undefined
      const id = path?.id ?? (input.sessionID as string | undefined)
      return { data: id ? byID.get(id) : undefined }
    })
    const handler = await loadHandler(sessions, async () => ({ data: [sessions[1]] }), get)

    await handler({
      event: { type: 'question.asked', properties: { id: 'que_child', sessionID: 'child' } }
    })

    expect(get).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(['AskUserQuestion'])
    expect(posts[0].sessionID).toBe('root')
  })

  it('retries an undelivered same-state transition after a non-2xx response', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)).payload as RecordedPost)
        calls += 1
        return new Response(null, { status: calls === 1 ? 401 : 204 })
      }) as typeof globalThis.fetch
      const handler = await loadHandler([{ id: 'root' }])

      await handler({ event: status('root', 'busy') })
      await handler({ event: status('root', 'retry') })
      expect(names()).toEqual(['SessionBusy'])

      await vi.advanceTimersByTimeAsync(500)
      expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes factory state so a reloaded plugin cannot inherit stale waiting', async () => {
    const first = await loadHooks([{ id: 'root' }])
    await first.event({ event: status('root', 'busy') })
    await first.event({
      event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'root' } }
    })
    await first.dispose?.()

    const second = await loadHooks([{ id: 'root' }])
    await second.event({ event: status('root', 'busy') })
    await first.event({ event: status('root', 'idle') })

    // Disposal owns the last live root/request, so it must retire the stale
    // attention state before the replacement factory starts working.
    expect(names()).toEqual(['SessionBusy', 'PermissionRequest', 'SessionIdle', 'SessionBusy'])
  })

  it('aggregates roots across the directory factories used by one TUI process', async () => {
    const first = await loadHooks([{ id: 'root-a' }])
    const second = await loadHooks([{ id: 'root-b' }])

    await first.event({ event: status('root-a', 'busy') })
    await second.event({ event: status('root-b', 'busy') })
    await second.event({ event: status('root-b', 'idle') })

    // Directory B finishing must restore A as the active root, not mark the
    // shared Orca pane done while A is still running.
    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'SessionBusy'])
    expect(posts.map((post) => post.sessionID)).toEqual(['root-a', 'root-b', 'root-a'])

    await first.event({ event: status('root-a', 'idle') })
    expect(names().at(-1)).toBe('SessionIdle')

    await Promise.all([first.dispose?.(), second.dispose?.()])
  })

  it('disposes only its directory ownership and restores another busy factory', async () => {
    const first = await loadHooks([{ id: 'root-a' }])
    const second = await loadHooks([{ id: 'root-b' }])

    await first.event({ event: status('root-a', 'busy') })
    await second.event({ event: status('root-b', 'busy') })
    await first.event({
      event: { type: 'permission.asked', properties: { id: 'per_a', sessionID: 'root-a' } }
    })
    await first.dispose?.()

    expect(names().slice(-2)).toEqual(['PermissionRequest', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root-b')

    await second.event({ event: status('root-b', 'idle') })
    expect(names().at(-1)).toBe('SessionIdle')
    await second.dispose?.()
  })

  it('retries a failed idle transition without duplicate-event flooding', async () => {
    vi.useFakeTimers()
    try {
      let idleAttempts = 0
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)).payload as RecordedPost
        posts.push(payload)
        if (payload.hook_event_name === 'SessionIdle') {
          idleAttempts += 1
          return new Response(null, { status: idleAttempts === 1 ? 503 : 204 })
        }
        return new Response(null, { status: 204 })
      }) as typeof globalThis.fetch
      const handler = await loadHandler([{ id: 'root' }])

      await handler({ event: status('root', 'busy') })
      await handler({ event: status('root', 'idle') })
      await handler({ event: { type: 'session.idle', properties: { sessionID: 'root' } } })

      // Canonical + deprecated idle share the scheduled retry instead of both
      // hammering a temporarily unavailable Orca listener.
      expect(idleAttempts).toBe(1)
      await vi.advanceTimersByTimeAsync(499)
      expect(idleAttempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(idleAttempts).toBe(2)
      expect(names().slice(-2)).toEqual(['SessionIdle', 'SessionIdle'])

      await vi.advanceTimersByTimeAsync(60_000)
      expect(idleAttempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives idle a fresh retry cadence after a delivered waiting state', async () => {
    vi.useFakeTimers()
    try {
      let idleCanSucceed = false
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)).payload as RecordedPost
        posts.push(payload)
        if (payload.hook_event_name === 'SessionIdle' && !idleCanSucceed) {
          return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }) as typeof globalThis.fetch
      const handler = await loadHandler([{ id: 'root' }])

      await handler({ event: status('root', 'busy') })
      await handler({ event: status('root', 'idle') })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(7)

      await handler({
        event: { type: 'permission.asked', properties: { id: 'per_after_idle', sessionID: 'root' } }
      })
      expect(names().at(-1)).toBe('PermissionRequest')

      idleCanSucceed = true
      await handler({
        event: {
          type: 'permission.replied',
          properties: { requestID: 'per_after_idle', sessionID: 'root', reply: 'once' }
        }
      })

      expect(names().at(-1)).toBe('SessionIdle')
      expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never retries a failed final preview after authoritative idle', async () => {
    vi.useFakeTimers()
    try {
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)).payload as RecordedPost
        posts.push(payload)
        return new Response(null, { status: payload.hook_event_name === 'MessagePart' ? 503 : 204 })
      }) as typeof globalThis.fetch
      const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

      await handler({ event: status('root', 'busy') })
      await handler({
        event: { type: 'permission.asked', properties: { id: 'per_child', sessionID: 'child' } }
      })
      await handler({ event: messageUpdated('root', 'message-root', 'assistant') })
      await handler({ event: messagePart('root', 'message-root', 'final preview') })
      await handler({ event: status('root', 'idle') })
      await handler({
        event: {
          type: 'permission.replied',
          properties: { requestID: 'per_child', sessionID: 'child', reply: 'once' }
        }
      })

      expect(names().slice(-2)).toEqual(['MessagePart', 'SessionIdle'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(names().at(-1)).toBe('SessionIdle')
      expect(names().filter((name) => name === 'MessagePart')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a stalled post and lets the queued idle transition recover', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)).payload as RecordedPost
        posts.push(payload)
        calls += 1
        if (calls > 1) {
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
      }) as typeof globalThis.fetch
      const handler = await loadHandler([{ id: 'root' }])

      const busy = handler({ event: status('root', 'busy') })
      const idle = handler({ event: status('root', 'idle') })
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.all([busy, idle])

      // Even though working could not be delivered, observed activity makes
      // the recovered idle post authoritative instead of deduping it away.
      expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves event order while an earlier hook post is delayed', async () => {
    let releaseFirstFetch: (() => void) | undefined
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    let notifyFirstFetchStarted: (() => void) | undefined
    const firstFetchStarted = new Promise<void>((resolve) => {
      notifyFirstFetchStarted = resolve
    })
    let fetchCalls = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      if (fetchCalls === 1) {
        notifyFirstFetchStarted?.()
        await firstFetch
      }
      posts.push(payload)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root' }])

    const busy = handler({ event: status('root', 'busy') })
    await firstFetchStarted
    const idle = handler({ event: status('root', 'idle') })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    releaseFirstFetch?.()
    await Promise.all([busy, idle])

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('throttles assistant previews independently for concurrent root sessions', async () => {
    const handler = await loadHandler([{ id: 'root-a' }, { id: 'root-b' }])

    for (const root of ['root-a', 'root-b']) {
      await handler({ event: messageUpdated(root, `message-${root}`, 'assistant') })
      await handler({ event: messagePart(root, `message-${root}`, `reply-${root}`) })
    }

    expect(names()).toEqual(['MessagePart', 'MessagePart'])
    expect(posts.map((post) => post.text)).toEqual(['reply-root-a', 'reply-root-b'])
  })
})
