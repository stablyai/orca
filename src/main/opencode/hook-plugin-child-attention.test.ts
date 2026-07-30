/**
 * Executes the generated OpenCode plugin artifact to verify that descendant
 * blockers roll up to their root pane without giving child lifecycle or
 * message events authority over that pane.
 */
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
type PluginFactory = (ctx: unknown) => Promise<PluginHooks>
type SessionList = (
  parameters?: { signal?: AbortSignal },
  options?: { signal?: AbortSignal }
) => Promise<{ data: SessionFixture[] }>
type RecordedPost = {
  hook_event_name: string
  id?: string
  sessionID?: string
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode plugin child attention', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch
  let pluginFactory: PluginFactory | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-child-attention-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    pluginFactory = undefined
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: RecordedPost }
      posts.push(body.payload)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.useRealTimers()
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

  async function createHooks(
    sessions: SessionFixture[],
    list: SessionList = async () => ({
      data: sessions
    })
  ): Promise<PluginHooks> {
    if (!pluginFactory) {
      const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
      writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
      const module = (await import(pathToFileURL(pluginPath).href)) as {
        OrcaOpenCodeStatusPlugin: PluginFactory
      }
      pluginFactory = module.OrcaOpenCodeStatusPlugin
    }
    return pluginFactory({
      client: {
        session: {
          list
        }
      }
    })
  }

  function status(type: 'busy' | 'idle', sessionID: string): PluginEvent {
    return {
      type: 'session.status',
      properties: { sessionID, status: { type } }
    }
  }

  function attention(
    type: 'permission.asked' | 'question.asked',
    id: string,
    sessionID: string,
    tool?: { messageID: string; callID: string }
  ): PluginEvent {
    return {
      type,
      properties: { id, sessionID, ...(tool ? { tool } : {}) }
    }
  }

  function resolution(
    type: 'permission.replied' | 'question.replied' | 'question.rejected',
    requestID: string,
    sessionID: string
  ): PluginEvent {
    return {
      type,
      properties: { requestID, sessionID }
    }
  }

  function completedQuestion(
    sessionID: string,
    messageID: string,
    callID: string,
    status: 'completed' | 'error' = 'completed'
  ): PluginEvent {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: {
          type: 'tool',
          tool: 'question',
          messageID,
          callID,
          state: { status }
        }
      }
    }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  it.each([
    ['permission.asked', 'PermissionRequest'],
    ['question.asked', 'AskUserQuestion']
  ] as const)('attributes nested child %s to the root pane', async (type, expectedName) => {
    const hooks = await createHooks([
      { id: 'root' },
      { id: 'child', parentID: 'root' },
      { id: 'grandchild', parentID: 'child' }
    ])

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: attention(type, 'request-1', 'grandchild') })

    expect(posts.at(-1)).toMatchObject({
      hook_event_name: expectedName,
      id: 'request-1',
      sessionID: 'root'
    })
  })

  it('clears only the matching child reply or rejection and preserves root Busy', async () => {
    const hooks = await createHooks([
      { id: 'root' },
      { id: 'child-a', parentID: 'root' },
      { id: 'child-b', parentID: 'root' }
    ])

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: attention('question.asked', 'question-a', 'child-a') })
    const waitingPosts = posts.length
    await hooks.event({ event: status('busy', 'root') })
    expect(posts).toHaveLength(waitingPosts)

    await hooks.event({ event: attention('permission.asked', 'permission-b', 'child-b') })
    await hooks.event({
      event: resolution('permission.replied', 'permission-b', 'child-a')
    })
    expect(posts.at(-1)?.hook_event_name).toBe('PermissionRequest')

    await hooks.event({
      event: resolution('permission.replied', 'permission-b', 'child-b')
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      id: 'question-a',
      sessionID: 'root'
    })

    await hooks.event({
      event: resolution('question.rejected', 'question-a', 'child-a')
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'SessionBusy',
      sessionID: 'root'
    })

    await hooks.event({ event: status('idle', 'root') })
    expect(posts.at(-1)?.hook_event_name).toBe('SessionIdle')
  })

  it.each(['completed', 'error'] as const)(
    'clears only the matching child question when its tool is %s',
    async (completionStatus) => {
      const hooks = await createHooks([
        { id: 'root' },
        { id: 'child-a', parentID: 'root' },
        { id: 'child-b', parentID: 'root' }
      ])
      const toolA = { messageID: 'message-a', callID: 'call-a' }
      const toolB = { messageID: 'message-b', callID: 'call-b' }

      await hooks.event({
        event: attention('question.asked', 'question-a', 'child-a', toolA)
      })
      await hooks.event({
        event: attention('question.asked', 'question-b', 'child-b', toolB)
      })
      const waitingPosts = posts.length
      await hooks.event({
        event: completedQuestion('child-a', toolB.messageID, toolB.callID, completionStatus)
      })
      await hooks.event({
        event: completedQuestion('child-b', toolB.messageID, 'wrong-call', completionStatus)
      })
      expect(posts).toHaveLength(waitingPosts)

      await hooks.event({
        event: completedQuestion('child-b', toolB.messageID, toolB.callID, completionStatus)
      })
      expect(posts.at(-1)).toMatchObject({
        hook_event_name: 'AskUserQuestion',
        id: 'question-a',
        sessionID: 'root'
      })

      await hooks.event({
        event: completedQuestion('child-a', toolA.messageID, toolA.callID, completionStatus)
      })
      expect(posts.at(-1)).toMatchObject({
        hook_event_name: 'SessionIdle',
        sessionID: 'root'
      })
    }
  )

  it('uses child Idle only to clean that child blocker, then restores root Busy', async () => {
    const hooks = await createHooks([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: attention('question.asked', 'question-child', 'child') })
    await hooks.event({ event: status('idle', 'child') })

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('lets only matching unknown Idle retire attention across cyclic ancestry', async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: 'child-a', parentID: 'child-b' },
        { id: 'child-b', parentID: 'child-a' }
      ]
    }))
    const hooks = await createHooks([], list)

    await hooks.event({
      event: attention('question.asked', 'cyclic-question', 'child-a')
    })
    await hooks.event({ event: status('idle', 'child-b') })
    expect(names()).toEqual(['AskUserQuestion'])

    await hooks.event({ event: status('idle', 'child-a') })

    expect(names()).toEqual(['AskUserQuestion', 'SessionIdle'])
    expect(posts[0]).toMatchObject({
      id: 'cyclic-question',
      sessionID: 'child-a'
    })
    expect(posts.at(-1)?.sessionID).toBe('child-a')
    expect(list).toHaveBeenCalledTimes(6)
  })

  it('matches a child reply after its ancestry lookup fails', async () => {
    let lookupFails = false
    const list = vi.fn(async () => {
      if (lookupFails) {
        throw new Error('lookup unavailable')
      }
      return { data: [{ id: 'root' }] }
    })
    const hooks = await createHooks([], list)

    await hooks.event({ event: status('busy', 'root') })
    lookupFails = true
    await hooks.event({
      event: attention('permission.asked', 'permission-child', 'child')
    })
    await hooks.event({
      event: resolution('permission.replied', 'permission-child', 'child')
    })

    expect(names()).toEqual(['SessionBusy', 'PermissionRequest', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('clears timed-out child attention without repeating its ancestry lookup', async () => {
    vi.useFakeTimers()
    let lookupHangs = false
    const list = vi.fn(
      async (options?: { signal?: AbortSignal }): Promise<{ data: SessionFixture[] }> => {
        if (!lookupHangs) {
          return { data: [{ id: 'root' }] }
        }
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
      }
    )
    const hooks = await createHooks([], list)
    await hooks.event({ event: status('busy', 'root') })
    lookupHangs = true

    const asked = hooks.event({
      event: attention('question.asked', 'question-child', 'child')
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await asked
    const lookupCountAfterAsk = list.mock.calls.length
    const replied = hooks.event({
      event: resolution('question.replied', 'question-child', 'child')
    })
    await replied

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
    expect(list).toHaveBeenCalledTimes(lookupCountAfterAsk)
  })

  it('clears timed-out child attention on Idle without making unknown Idle authoritative', async () => {
    vi.useFakeTimers()
    let lookupHangs = false
    const list = vi.fn(
      async (options?: { signal?: AbortSignal }): Promise<{ data: SessionFixture[] }> => {
        if (!lookupHangs) {
          return { data: [{ id: 'root' }] }
        }
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
      }
    )
    const hooks = await createHooks([], list)
    await hooks.event({ event: status('busy', 'root') })
    lookupHangs = true

    const asked = hooks.event({
      event: attention('question.asked', 'question-child', 'child')
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await asked
    const idle = hooks.event({ event: status('idle', 'child') })
    await vi.advanceTimersByTimeAsync(2_000)
    await idle

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('delivers same-id child blockers across factories when the older owner resolves first', async () => {
    const first = await createHooks([{ id: 'root-a' }, { id: 'child-a', parentID: 'root-a' }])
    const second = await createHooks([{ id: 'root-b' }, { id: 'child-b', parentID: 'root-b' }])

    await first.event({ event: status('busy', 'root-a') })
    await second.event({ event: status('busy', 'root-b') })
    await first.event({ event: attention('question.asked', 'same-id', 'child-a') })
    await second.event({ event: attention('question.asked', 'same-id', 'child-b') })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      id: 'same-id',
      sessionID: 'root-b'
    })
    const postsAfterSecondBlocker = posts.length

    await first.event({
      event: resolution('question.replied', 'same-id', 'child-a')
    })
    expect(posts).toHaveLength(postsAfterSecondBlocker)
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      id: 'same-id',
      sessionID: 'root-b'
    })

    await second.event({
      event: resolution('question.replied', 'same-id', 'child-b')
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'SessionBusy',
      sessionID: 'root-b'
    })
  })

  it('keeps same-id blockers from separate sessions in one factory independent', async () => {
    const hooks = await createHooks([
      { id: 'root-a' },
      { id: 'child-a', parentID: 'root-a' },
      { id: 'root-b' },
      { id: 'child-b', parentID: 'root-b' }
    ])

    await hooks.event({ event: status('busy', 'root-a') })
    await hooks.event({ event: status('busy', 'root-b') })
    await hooks.event({ event: attention('question.asked', 'same-id', 'child-a') })
    await hooks.event({ event: attention('question.asked', 'same-id', 'child-b') })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      sessionID: 'root-b'
    })

    await hooks.event({
      event: resolution('question.replied', 'same-id', 'child-a')
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      sessionID: 'root-b'
    })
  })

  it('keeps the oldest blocker waiting when 128 newer blockers resolve', async () => {
    const hooks = await createHooks([])

    // Why: live blocker ownership cannot be LRU-evicted; 129 crosses the prior 128-entry cap.
    for (let index = 1; index <= 129; index += 1) {
      await hooks.event({
        event: attention('question.asked', `question-${String(index)}`, `session-${String(index)}`)
      })
    }
    for (let index = 2; index <= 129; index += 1) {
      await hooks.event({
        event: resolution(
          'question.replied',
          `question-${String(index)}`,
          `session-${String(index)}`
        )
      })
    }

    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      id: 'question-1',
      sessionID: 'session-1'
    })
  })

  it('cleans only the disposed factory blocker', async () => {
    const first = await createHooks([{ id: 'root-a' }, { id: 'child-a', parentID: 'root-a' }])
    const second = await createHooks([{ id: 'root-b' }, { id: 'child-b', parentID: 'root-b' }])

    await first.event({ event: status('busy', 'root-a') })
    await second.event({ event: status('busy', 'root-b') })
    await first.event({ event: attention('question.asked', 'first-id', 'child-a') })
    await second.event({ event: attention('question.asked', 'second-id', 'child-b') })
    await second.dispose?.()
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'AskUserQuestion',
      id: 'first-id',
      sessionID: 'root-a'
    })

    await first.event({
      event: resolution('question.replied', 'first-id', 'child-a')
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'SessionBusy',
      sessionID: 'root-a'
    })
  })

  it('keeps child lifecycle, deltas, and text previews from overriding root status', async () => {
    const hooks = await createHooks([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child') })
    await hooks.event({ event: status('idle', 'child') })
    await hooks.event({
      event: {
        type: 'message.part.delta',
        properties: { sessionID: 'child', field: 'text', delta: 'child work' }
      }
    })
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'child',
          info: { id: 'child-message', role: 'assistant' }
        }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child',
          part: {
            type: 'text',
            text: 'private child preview',
            messageID: 'child-message'
          }
        }
      }
    })

    expect(names()).toEqual(['SessionBusy'])
    await hooks.event({ event: status('idle', 'root') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('does not let a delayed child Idle invalidate an in-flight parent preview', async () => {
    let releaseRootLookup: (() => void) | undefined
    const rootLookup = new Promise<void>((resolve) => {
      releaseRootLookup = resolve
    })
    let notifyRootLookup: (() => void) | undefined
    const rootLookupStarted = new Promise<void>((resolve) => {
      notifyRootLookup = resolve
    })
    let releaseChildLookup: (() => void) | undefined
    const childLookup = new Promise<void>((resolve) => {
      releaseChildLookup = resolve
    })
    let notifyChildLookup: (() => void) | undefined
    const childLookupStarted = new Promise<void>((resolve) => {
      notifyChildLookup = resolve
    })
    let calls = 0
    const sessions = [{ id: 'root' }, { id: 'child', parentID: 'root' }]
    const list = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        notifyRootLookup?.()
        await rootLookup
      } else if (calls === 2) {
        notifyChildLookup?.()
        await childLookup
      }
      return { data: sessions }
    })
    const hooks = await createHooks([], list)

    const seedRole = hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'root',
          info: { id: 'parent-message', role: 'assistant' }
        }
      }
    })
    await rootLookupStarted
    const preview = hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'parent preview', messageID: 'parent-message' }
        }
      }
    })
    const childIdle = hooks.event({ event: status('idle', 'child') })

    try {
      releaseRootLookup?.()
      await childLookupStarted
      await vi.waitFor(() => expect(names()).toEqual(['MessagePart']))
    } finally {
      releaseChildLookup?.()
    }
    await Promise.all([seedRole, preview, childIdle])

    // Why: child completion may clean its blockers, but it cannot cancel or
    // replace a parent preview that was already on its way to the pane.
    expect(names()).toEqual(['MessagePart'])
  })
})
