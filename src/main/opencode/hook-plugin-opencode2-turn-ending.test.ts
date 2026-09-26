/**
 * Replays events captured from OpenCode 2 through the generated plugin's setup() bridge to
 * verify how each root turn ending reaches Orca: the error or the user's stop is named on the
 * root's own state, and a turn that recovers or only a child that fails is never named.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPENCODE2_TURN_ENDING_CAPTURES,
  type OpenCode2CapturedEvent
} from './opencode2-turn-ending-captures.test-fixture'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock }
}))

import { _internals } from './hook-service'

type RecordedPost = {
  hook_event_name?: string
  sessionID?: string
  root_state?: string
  root_turn_error_name?: string
}
type SessionRecord = { id: string; parentID?: string }
type PluginModule = {
  default?: { setup?: (ctx: unknown) => Promise<() => Promise<void>> }
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

const ROOT: SessionRecord = { id: 'ses_root' }
const CHILD: SessionRecord = { id: 'ses_child', parentID: 'ses_root' }

describe('OpenCode 2 root turn endings through setup()', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode2-turn-ending-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    // Why: OpenCode 2 installs as `opencode`, so its panes run the `opencode` plugin variant.
    process.env.ORCA_OPENCODE_AGENT = 'opencode'
    process.env.ORCA_AGENT_HOOK_PORT = '45679'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body))
      if (typeof body === 'object' && body !== null && 'payload' in body) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the plugin posts `{ payload }` with these string fields; the assertions read them by name.
        posts.push(body.payload as RecordedPost)
      }
      return new Response(null, { status: 204 })
    })
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

  async function replay(
    events: readonly OpenCode2CapturedEvent[],
    sessions: readonly SessionRecord[] = [ROOT]
  ): Promise<void> {
    // Why: a unique basename per load defeats the ESM module cache, so no state leaks between cases.
    const pluginPath = join(tempDir, `orca-opencode-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generated module default-exports the plugin definition checked below.
    const module = (await import(pathToFileURL(pluginPath).href)) as PluginModule
    let drained = false
    const cleanup = await module.default?.setup?.({
      session: {
        // OpenCode 2 resolves a session to its bare record.
        get: async (input: { sessionID: string }, _options: unknown) =>
          sessions.find((session) => session.id === input.sessionID),
        hook: async () => ({ dispose: async () => {} })
      },
      event: {
        subscribe: async function* () {
          yield* events
          drained = true
        }
      }
    })
    expect(cleanup).toBeTypeOf('function')
    // The bridge pulls the next event only after the previous one was handled.
    await vi.waitFor(() => expect(drained).toBe(true))
    // Why: disposal publishes its own final Idle, which is not part of the replayed turn.
    const replayed = [...posts]
    await cleanup?.()
    posts = replayed
  }

  function lastIdle(): RecordedPost | undefined {
    return posts.findLast((post) => post.hook_event_name === 'SessionIdle')
  }

  it('names the provider error that failed the root turn on its Idle', async () => {
    await replay(OPENCODE2_TURN_ENDING_CAPTURES.providerError)

    expect(lastIdle()).toEqual({
      hook_event_name: 'SessionIdle',
      sessionID: 'ses_root',
      root_state: 'done',
      root_turn_error_name: 'provider.invalid-request'
    })
    // The failed step alone is not the verdict; only the execution's end names it.
    expect(posts.filter((post) => post.root_turn_error_name !== undefined)).toHaveLength(1)
  })

  it.each([
    ['text streams', OPENCODE2_TURN_ENDING_CAPTURES.escapeMidStream],
    ['a tool runs', OPENCODE2_TURN_ENDING_CAPTURES.escapeDuringTool]
  ])('names a user stop while %s as an aborted message', async (_label, events) => {
    await replay(events)

    expect(lastIdle()).toMatchObject({
      root_state: 'done',
      root_turn_error_name: 'MessageAbortedError'
    })
  })

  it('names an overflow whose compaction was rejected', async () => {
    await replay(OPENCODE2_TURN_ENDING_CAPTURES.overflowCompactionRejected)

    expect(lastIdle()).toMatchObject({
      root_state: 'done',
      root_turn_error_name: 'provider.invalid-request'
    })
  })

  it('never names an overflow that compaction recovered', async () => {
    await replay(OPENCODE2_TURN_ENDING_CAPTURES.overflowCompactionSucceeded)

    expect(posts.some((post) => post.root_turn_error_name !== undefined)).toBe(false)
    expect(lastIdle()).toEqual({
      hook_event_name: 'SessionIdle',
      sessionID: 'ses_root',
      root_state: 'done'
    })
  })

  it('names a root failure at once while its child still runs, and again after the child wakes it', async () => {
    const events = OPENCODE2_TURN_ENDING_CAPTURES.rootFailsWhileChildRuns
    const firstFailure = events.findIndex((event) => event.type === 'session.execution.failed')
    await replay(events.slice(0, firstFailure + 1), [ROOT, CHILD])

    // The pane stays busy for the child, but the root's own turn already failed.
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'SessionBusy',
      root_state: 'done',
      root_turn_error_name: 'provider.invalid-request'
    })

    posts = []
    await replay(events, [ROOT, CHILD])
    const rewake = posts.findLastIndex((post) => post.root_state === 'working')
    expect(rewake).toBeGreaterThan(-1)
    expect(posts[rewake]).not.toHaveProperty('root_turn_error_name')
    expect(lastIdle()).toMatchObject({
      root_state: 'done',
      root_turn_error_name: 'provider.invalid-request'
    })
  })

  it('ignores a failed child for the root', async () => {
    await replay(
      [
        { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
        { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root' } },
        { type: 'session.execution.started', data: { sessionID: 'ses_child' } },
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } },
        {
          type: 'session.execution.failed',
          data: {
            sessionID: 'ses_child',
            error: { type: 'provider.invalid-request', message: 'rejected', status: 400 }
          }
        }
      ],
      [ROOT, CHILD]
    )

    expect(posts.some((post) => post.root_turn_error_name !== undefined)).toBe(false)
    expect(lastIdle()).toMatchObject({ root_state: 'done' })
  })

  it.each(['inactivity', 'shutdown', 'superseded'])(
    'does not call an interrupt for %s a user stop',
    async (reason) => {
      await replay([
        { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
        { type: 'session.execution.interrupted', data: { sessionID: 'ses_root', reason } }
      ])

      expect(lastIdle()).toEqual({
        hook_event_name: 'SessionIdle',
        sessionID: 'ses_root',
        root_state: 'done'
      })
    }
  )

  it('still names a failed execution whose error carries no type', async () => {
    await replay([
      { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
      { type: 'session.execution.failed', data: { sessionID: 'ses_root', error: {} } }
    ])

    expect(lastIdle()).toMatchObject({ root_turn_error_name: 'UnknownError' })
  })
})
