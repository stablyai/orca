import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'
import { fakeTui, type BusEvent } from './opencode-tui-session-fixture'

type Post = {
  paneKey?: string
  opencodeMajor?: number
  payload?: {
    hook_event_name?: string
    sessionID?: string
    root_state?: string
    root_turn_error_name?: string
  }
}
type PluginModule = {
  default?: { setup?: (ctx: unknown) => Promise<(() => Promise<void>) | undefined> }
}

const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SES_A = 'ses_f161fd85fffeieT0zYt80ZKorS'
const SES_B = 'ses_f161fcd7affeffV0OOrMCrTxtQ'
const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN'
] as const

// Event shapes as OpenCode 2.0.14 delivers them to both server and TUI plugins.
function turn(sessionID: string, text: string): { start: BusEvent[]; finish: BusEvent[] } {
  const assistantMessageID = `msg_${sessionID}_a`
  return {
    start: [
      {
        type: 'session.created',
        data: { sessionID, projectID: 'global', location: { directory: '/proj' }, subpath: '' }
      },
      {
        type: 'session.inbox.enqueued',
        data: {
          sessionID,
          inboxID: `msg_${sessionID}_u`,
          item: { type: 'user', payload: { text, files: [] }, delivery: 'steer' }
        }
      },
      { type: 'session.execution.started', data: { sessionID } },
      { type: 'session.step.started', data: { sessionID, assistantMessageID, agent: 'build' } },
      { type: 'session.text.started', data: { sessionID, assistantMessageID, ordinal: 0 } }
    ],
    finish: [
      {
        type: 'session.text.ended',
        data: { sessionID, assistantMessageID, ordinal: 0, text: 'tick0 tick1 ' }
      },
      { type: 'session.step.ended', data: { sessionID, assistantMessageID, finish: 'stop' } },
      { type: 'session.execution.succeeded', data: { sessionID } }
    ]
  }
}

describe('OpenCode 2 TUI reporter: each pane reports its own sessions', () => {
  let tempDir: string
  let savedFetch: typeof globalThis.fetch
  let savedEnv: Record<string, string | undefined>
  let savedArgv: string[]
  let posts: Post[]
  // Every post in arrival order, including the start boundary each fresh TUI lands.
  let allPosts: Post[]
  let failPosts: boolean
  let postDelayMs: number
  const cleanups = new Set<() => Promise<void>>()
  const delayedPosts = new Set<() => void>()

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-tui-adapter-'))
    savedFetch = globalThis.fetch
    savedArgv = process.argv
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_OPENCODE_AGENT = 'opencode'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    posts = []
    allPosts = []
    failPosts = false
    postDelayMs = 0
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      if (postDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer)
            delayedPosts.delete(finish)
            resolve()
          }
          const timer = setTimeout(finish, postDelayMs)
          delayedPosts.add(finish)
        })
      }
      if (failPosts) {
        return new Response('{}', { status: 500 })
      }
      allPosts.push(body)
      // Why apart: a fresh TUI's start boundary names no session; per-session cases assert what follows it.
      if (
        body.payload?.hook_event_name !== 'SessionStart' ||
        body.payload.sessionID !== undefined
      ) {
        posts.push(body)
      }
      return new Response('{}', { status: 200 })
    })
  })

  afterEach(async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      postDelayMs = 0
      for (const finish of delayedPosts) {
        finish()
      }
      const closing = Promise.allSettled([...cleanups].map((cleanup) => cleanup()))
      expect(
        await Promise.race([
          closing.then((results) => results.every((result) => result.status === 'fulfilled')),
          new Promise<boolean>((resolve) => {
            deadline = realSetTimeout(() => resolve(false), 2000)
          })
        ])
      ).toBe(true)
    } finally {
      realClearTimeout(deadline)
      try {
        if (vi.isFakeTimers()) {
          expect(vi.getTimerCount()).toBe(0)
        }
      } finally {
        if (vi.isFakeTimers()) {
          vi.clearAllTimers()
        }
        vi.useRealTimers()
        cleanups.clear()
        delayedPosts.clear()
        globalThis.fetch = savedFetch
        process.argv = savedArgv
        for (const key of ENV_KEYS) {
          if (savedEnv[key] === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = savedEnv[key]
          }
        }
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  })

  async function loadPlugin(dir = tempDir): Promise<PluginModule> {
    // Why: a unique basename per load defeats the ESM module cache, like a separate process.
    const pluginPath = join(dir, `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generated module's default export is exercised below and fails the test if absent.
    const plugin = (await import(pathToFileURL(pluginPath).href)) as PluginModule
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
      })
    }
    const setup = plugin.default?.setup
    return {
      default: {
        setup: async (ctx) => {
          const cleanup = await setup?.(ctx)
          if (!cleanup) {
            return
          }
          const close = async (): Promise<void> => {
            try {
              await cleanup()
              if (vi.isFakeTimers()) {
                expect(vi.getTimerCount()).toBe(0)
              }
            } finally {
              cleanups.delete(close)
            }
          }
          cleanups.add(close)
          return close
        }
      }
    }
  }

  const summary = (list: Post[]): string[] =>
    list.map((post) => `${post.payload?.hook_event_name}:${post.payload?.sessionID}`)

  async function runPane(
    paneKey: string,
    ownSession: string,
    script: (tui: ReturnType<typeof fakeTui>) => Promise<void>
  ): Promise<Post[]> {
    process.env.ORCA_PANE_KEY = paneKey
    const start = posts.length
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    await script(tui)
    await waitFor(() => {
      expect(summary(posts.slice(start)).at(-1)).toBe(`SessionIdle:${ownSession}`)
    })
    await cleanup?.()
    return posts.slice(start)
  }

  const tick = async (ms = 20): Promise<void> => {
    await (vi.isFakeTimers()
      ? vi.advanceTimersByTimeAsync(ms)
      : new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }
  const waitFor = async (
    check: () => void,
    { timeout = 1000 }: { timeout?: number } = {}
  ): Promise<void> => {
    if (!vi.isFakeTimers()) {
      await vi.waitFor(check, { timeout })
      return
    }
    const deadline = Date.now() + timeout
    await tick(0)
    for (;;) {
      try {
        check()
        return
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error
        }
        await tick(Math.min(50, deadline - Date.now()))
      }
    }
  }
  const pump = async (tui: ReturnType<typeof fakeTui>, events: BusEvent[]): Promise<void> => {
    for (const event of events) {
      tui.emit(event)
      await tick()
    }
  }

  it.each([
    ['session.execution.failed', { error: { type: 'api' } }, 'api'],
    ['session.execution.failed', {}, 'UnknownError'],
    ['session.execution.interrupted', { reason: 'user' }, 'MessageAbortedError'],
    ['session.execution.interrupted', { reason: 'pause' }, undefined],
    ['session.execution.succeeded', {}, undefined]
  ])('carries the root verdict for %s', async (type, fields, errorName) => {
    const reported = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'root').start)
      await pump(tui, [{ type, data: { sessionID: SES_A, ...fields } }])
    })
    expect(reported.at(-1)?.payload).toMatchObject({ root_state: 'done' })
    expect(reported.at(-1)?.payload?.root_turn_error_name).toBe(errorName)
  })

  it('clears a failed root verdict on its next turn', async () => {
    const reported = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'first').start)
      await pump(tui, [{ type: 'session.execution.failed', data: { sessionID: SES_A } }])
      await pump(tui, [{ type: 'session.execution.started', data: { sessionID: SES_A } }])
      await pump(tui, turn(SES_A, 'next').finish)
    })
    expect(reported.at(-1)?.payload?.root_turn_error_name).toBeUndefined()
  })

  // Captured s2 shape: pane A's long turn overlapped by pane B's short one on one server.
  it('gives each overlapping pane only its own session and its own Idle', async () => {
    const a = turn(SES_A, 'A long SLEEP=12')
    const b = turn(SES_B, 'B short SLEEP=3')
    const bus = [...a.start, ...b.start, ...b.finish, ...a.finish]
    const paneA = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, bus)
    })
    const paneB = await runPane(PANE_B, SES_B, async (tui) => {
      await pump(tui, [...a.start])
      tui.navigate(SES_B)
      await pump(tui, [...b.start, ...b.finish, ...a.finish])
    })

    expect(paneA.every((post) => post.paneKey === PANE_A)).toBe(true)
    expect(paneB.every((post) => post.paneKey === PANE_B)).toBe(true)
    // Keeps the host's OpenCode 1 session binder off these posts.
    expect([...paneA, ...paneB].every((post) => post.opencodeMajor === 2)).toBe(true)
    expect(new Set(paneA.map((post) => post.payload?.sessionID))).toEqual(new Set([SES_A]))
    expect(new Set(paneB.map((post) => post.payload?.sessionID))).toEqual(new Set([SES_B]))
    for (const [list, session] of [
      [paneA, SES_A],
      [paneB, SES_B]
    ] as const) {
      const names = summary(list)
      expect(names[0]).toBe(`SessionStart:${session}`)
      expect(names).toContain(`SessionBusy:${session}`)
      expect(names.at(-1)).toBe(`SessionIdle:${session}`)
    }
  })

  // Captured s5 shape: the TUI's route reached the new session after execution had started.
  it('hydrates a session whose route switch lands after execution started', async () => {
    const b = turn(SES_B, 'B tui SLEEP=4')
    const paneB = await runPane(PANE_B, SES_B, async (tui) => {
      await pump(tui, b.start)
      expect(posts).toHaveLength(0)
      tui.navigate(SES_B)
      await waitFor(() => {
        expect(summary(posts)).toContain(`SessionBusy:${SES_B}`)
      })
      await pump(tui, b.finish)
    })

    const names = summary(paneB)
    expect(names.slice(0, 3)).toEqual([
      `SessionStart:${SES_B}`,
      `MessagePart:${SES_B}`,
      `SessionBusy:${SES_B}`
    ])
    expect(names.at(-1)).toBe(`SessionIdle:${SES_B}`)
  })

  it('keeps a started turn until it settles after the route moves on', async () => {
    const a = turn(SES_A, 'A long')
    const paneA = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, a.start)
      tui.navigate('ses_other_idle_session')
      await tick(250)
      await pump(tui, a.finish)
    })
    expect(summary(paneA)).toContain(`SessionBusy:${SES_A}`)
    expect(summary(paneA).at(-1)).toBe(`SessionIdle:${SES_A}`)
  })

  it('reports nothing for sessions the pane never showed', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    const b = turn(SES_B, 'another pane')
    await pump(tui, [...b.start, ...b.finish])
    await tick(250)
    await cleanup?.()
    expect(posts).toEqual([])
  })

  // Why: a turn the TUI did not see end must not hold the pane Working (e.g. across a reconnect).
  it('settles an owned turn once the session data says it ended without an end event', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    tui.navigate(SES_A)
    await pump(tui, turn(SES_A, 'A').start)
    tui.loseEnd(SES_A)
    await tick(99)
    expect(summary(posts).at(-1)).toBe(`SessionBusy:${SES_A}`)
    await tick(1)
    expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`)
    await cleanup?.()
  })

  // Why: a turn that fails fast arrives as one burst; each level must post once, not flicker.
  it('does not settle a turn early while its events are still queued', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    tui.navigate(SES_A)
    await tick()
    const a = turn(SES_A, 'A fails fast')
    for (const event of [...a.start, ...a.finish]) {
      tui.emit(event)
    }
    await waitFor(() => {
      expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`)
    })
    await tick(250)
    await cleanup?.()
    const statuses = posts
      .map((post) => post.payload?.hook_event_name)
      .filter((name) => name === 'SessionBusy' || name === 'SessionIdle')
    expect(statuses).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('re-derives Working for an owned session whose start it missed', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    tui.navigate(SES_A)
    const first = turn(SES_A, 'A')
    await pump(tui, [...first.start, ...first.finish])
    await waitFor(() => {
      expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`)
    })
    tui.loseStart(SES_A)
    await waitFor(() => {
      expect(summary(posts).at(-1)).toBe(`SessionBusy:${SES_A}`)
    })
    tui.loseEnd(SES_A)
    await waitFor(() => {
      expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`)
    })
    await cleanup?.()
  })

  describe('derived from the session data', () => {
    const SES_CHILD = 'ses_f161fe00affeChildSubagent1'
    const statuses = (list: Post[]): string[] =>
      summary(list).filter((name) =>
        /^(SessionBusy|SessionIdle|PermissionRequest|AskUserQuestion):/.test(name)
      )
    const start = async (
      tui: ReturnType<typeof fakeTui>
    ): Promise<(() => Promise<void>) | undefined> => {
      process.env.ORCA_PANE_KEY = PANE_A
      return (await loadPlugin()).default?.setup?.(tui.ctx)
    }
    const childStart = (parentID: string): BusEvent[] => [
      { type: 'session.created', data: { sessionID: SES_CHILD, parentID } },
      { type: 'session.execution.started', data: { sessionID: SES_CHILD } }
    ]
    const permission = (sessionID: string): BusEvent => ({
      type: 'permission.asked',
      data: { id: 'per_1', sessionID, action: 'bash', resources: ['rm -rf build'] }
    })

    it('publishes a root failure while its child keeps the aggregate Working', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, [...turn(SES_A, 'root').start, ...childStart(SES_A)])
      await pump(tui, [{ type: 'session.execution.failed', data: { sessionID: SES_A } }])
      await waitFor(() => {
        expect(posts.at(-1)?.payload).toMatchObject({
          hook_event_name: 'SessionBusy',
          root_state: 'done',
          root_turn_error_name: 'UnknownError'
        })
      })
      await pump(tui, [{ type: 'session.execution.succeeded', data: { sessionID: SES_CHILD } }])
      expect(posts.at(-1)?.payload?.root_turn_error_name).toBe('UnknownError')
      await cleanup?.()
    })

    it('does not turn a child failure into a root failure', async () => {
      const reported = await runPane(PANE_A, SES_A, async (tui) => {
        tui.navigate(SES_A)
        await pump(tui, [...turn(SES_A, 'root').start, ...childStart(SES_A)])
        await pump(tui, [{ type: 'session.execution.failed', data: { sessionID: SES_CHILD } }])
        await pump(tui, turn(SES_A, 'root').finish)
      })
      expect(reported.at(-1)?.payload?.root_turn_error_name).toBeUndefined()
    })

    it('keeps a failed terminal verdict through plugin hot reload', async () => {
      const tui = fakeTui()
      const first = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'root').start)
      await pump(tui, [{ type: 'session.execution.failed', data: { sessionID: SES_A } }])
      await waitFor(() => expect(posts.at(-1)?.payload?.root_turn_error_name).toBe('UnknownError'))
      await first?.()
      const before = posts.length
      const second = await start(tui)
      await tick(150)
      expect(posts).toHaveLength(before)
      expect(posts.at(-1)?.payload?.root_turn_error_name).toBe('UnknownError')
      await second?.()
    })

    it.each(['session.execution.succeeded', 'session.execution.interrupted'])(
      'repairs a failed verdict when %s follows a missed turn start during unload',
      async (finishType) => {
        const tui = fakeTui()
        const first = await start(tui)
        tui.navigate(SES_A)
        await pump(tui, turn(SES_A, 'first').start)
        await pump(tui, [{ type: 'session.execution.failed', data: { sessionID: SES_A } }])
        await first?.()
        await pump(tui, [
          { type: 'session.execution.started', data: { sessionID: SES_A } },
          { type: finishType, data: { sessionID: SES_A, reason: 'user' } }
        ])
        const second = await start(tui)
        await waitFor(() => expect(posts.at(-1)?.payload?.root_turn_error_name).toBeUndefined())
        expect(posts.at(-1)?.payload).toMatchObject({
          hook_event_name: 'SessionIdle',
          root_state: 'done'
        })
        await second?.()
      }
    )

    // Why: #23700 left this for TUI panes; a reload that misses the end must still reach Done.
    it('shows Done for a turn that ended while the plugin was reloading', async () => {
      const tui = fakeTui()
      const firstGeneration = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      await pump(tui, a.start)
      await waitFor(() => expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`]))
      const beforeReload = posts.length
      await firstGeneration?.()
      expect(posts).toHaveLength(beforeReload)
      await pump(tui, a.finish)
      const secondGeneration = await start(tui)
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await secondGeneration?.()
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`, `SessionIdle:${SES_A}`])
    })

    it('keeps a navigated-away turn across a reload and settles it after', async () => {
      const tui = fakeTui()
      const firstGeneration = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      await pump(tui, a.start)
      tui.navigate(SES_B)
      await tick(150)
      await firstGeneration?.()
      const secondGeneration = await start(tui)
      await tick(150)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`])
      await pump(tui, a.finish)
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await secondGeneration?.()
    })

    it('re-posts a level the previous generation could not deliver', async () => {
      const tui = fakeTui()
      failPosts = true
      const firstGeneration = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'A').start)
      await tick(50)
      await firstGeneration?.()
      failPosts = false
      const secondGeneration = await start(tui)
      await waitFor(() => expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`]))
      await secondGeneration?.()
    })

    // Why: with posts slower than events, the old adapter's decisions trailed the data and flickered.
    it('posts each level once and in order while posts are slow', async () => {
      postDelayMs = 120
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      const b = turn(SES_B, 'another pane')
      for (const event of [...a.start, ...b.start, ...b.finish, ...a.finish]) {
        tui.emit(event)
      }
      await tick(119)
      expect(allPosts).toEqual([])
      await tick(1)
      expect(summary(allPosts)).toEqual(['SessionStart:undefined'])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`), {
        timeout: 3000
      })
      await tick(300)
      await cleanup?.()
      // The reply text lands after Busy and before Idle, so Done shows it.
      expect(summary(posts)).toEqual([
        `SessionStart:${SES_A}`,
        `MessagePart:${SES_A}`,
        `SessionBusy:${SES_A}`,
        `MessagePart:${SES_A}`,
        `SessionIdle:${SES_A}`
      ])
      expect(posts.at(-2)?.payload).toMatchObject({ role: 'assistant', text: 'tick0 tick1 ' })
      expect(summary(allPosts)[0]).toBe('SessionStart:undefined')
    })

    // Why: Orca may still show this pane a status another process left, e.g. an older shared-service
    // plugin that posted another pane's turn here before an upgrade.
    it('lands one start boundary in a freshly started TUI, and none on a reload after Done', async () => {
      const tui = fakeTui()
      const firstGeneration = await start(tui)
      await waitFor(() => expect(summary(allPosts)).toEqual(['SessionStart:undefined']))
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      await pump(tui, [...a.start, ...a.finish])
      await waitFor(() => expect(summary(allPosts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await firstGeneration?.()
      const secondGeneration = await start(tui)
      await tick(250)
      await secondGeneration?.()
      expect(summary(allPosts).at(-1)).toBe(`SessionIdle:${SES_A}`)
      expect(summary(allPosts).filter((name) => name.startsWith('SessionStart:'))).toEqual([
        'SessionStart:undefined',
        `SessionStart:${SES_A}`
      ])
    })

    it('lands the start boundary only once across reloads of an idle pane', async () => {
      const tui = fakeTui()
      const firstGeneration = await start(tui)
      await waitFor(() => expect(summary(allPosts)).toEqual(['SessionStart:undefined']))
      await firstGeneration?.()
      const secondGeneration = await start(tui)
      await tick(150)
      await secondGeneration?.()
      expect(summary(allPosts)).toEqual(['SessionStart:undefined'])
    })

    it('names the idle session a freshly started TUI shows', async () => {
      const tui = fakeTui()
      tui.navigate(SES_B)
      const cleanup = await start(tui)
      await waitFor(() => expect(summary(allPosts)).toEqual([`SessionStart:${SES_B}`]))
      await cleanup?.()
    })

    it('posts Working instead of the start boundary when the route shows a running turn', async () => {
      const tui = fakeTui()
      tui.navigate(SES_A)
      tui.loseStart(SES_A)
      const cleanup = await start(tui)
      await waitFor(() => expect(summary(allPosts)).toEqual([`SessionBusy:${SES_A}`]))
      await tick(150)
      await cleanup?.()
      expect(summary(allPosts)).toEqual([`SessionBusy:${SES_A}`])
    })

    // Why: without plugin memory a reload cannot be told from a start, so it must not reset a Done.
    it('lands no start boundary where OpenCode keeps no plugin memory', async () => {
      const tui = fakeTui()
      Reflect.deleteProperty(tui.ctx, 'storage')
      const cleanup = await start(tui)
      await tick(150)
      await cleanup?.()
      expect(allPosts).toEqual([])
    })

    it('stays Working while a child session holds the turn, even if its end is missed', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A spawns a background task')
      await pump(tui, [...a.start, ...childStart(SES_A), ...a.finish])
      await tick(250)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`, `SessionBusy:${SES_A}`])
      expect(posts.at(-1)?.payload).toMatchObject({ root_state: 'done' })
      tui.loseEnd(SES_CHILD)
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await cleanup?.()
      expect(posts.every((post) => post.payload?.sessionID === SES_A)).toBe(true)
    })

    it('keeps automatically answered permissions Working without an attention post', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'auto').start)
      for (let index = 0; index < 3; index += 1) {
        tui.emit({
          type: 'permission.asked',
          data: { ...permission(SES_A).data, id: `auto_${index}` }
        })
        await tick(20)
        tui.emit({
          type: 'permission.replied',
          data: { sessionID: SES_A, requestID: `auto_${index}` }
        })
      }
      await tick(650)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`])
      await pump(tui, turn(SES_A, 'auto').finish)
      await cleanup?.()
    })

    it("shows a child's permission as Needs input on the root, then Working after the reply", async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      await pump(tui, [...a.start, ...childStart(SES_A)])
      await tick(60)
      await pump(tui, [permission(SES_CHILD)])
      await tick(479)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`])
      await tick(1)
      expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`)
      await pump(tui, [
        { type: 'permission.replied', data: { sessionID: SES_CHILD, requestID: 'per_1' } },
        { type: 'session.execution.succeeded', data: { sessionID: SES_CHILD } },
        ...a.finish
      ])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await cleanup?.()
      expect(statuses(posts)).toEqual([
        `SessionBusy:${SES_A}`,
        `PermissionRequest:${SES_A}`,
        `SessionBusy:${SES_A}`,
        `SessionIdle:${SES_A}`
      ])
    })

    // Why: Orca reads every MessagePart as Working, so reply text must not bury an open request.
    it('keeps Needs input while the root streams text beside a waiting background child', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A spawns a background task')
      await pump(tui, [...a.start, ...childStart(SES_A), permission(SES_CHILD)])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`))
      await pump(tui, a.finish)
      await tick(300)
      expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`)
      await cleanup?.()
    })

    it('clears Needs input answered while disconnected once the TUI reconnects', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, [...turn(SES_A, 'A').start, permission(SES_A)])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`))
      // The user browses away; the reply lands while this TUI is disconnected.
      tui.navigate(SES_B)
      await pump(tui, [{ type: 'server.connected', data: {} }])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionBusy:${SES_A}`))
      await cleanup?.()
    })

    it('ignores a reply that a reconnect fetch restores', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, [...turn(SES_A, 'A').start, permission(SES_A)])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`))
      const release = tui.holdPermissionFetch()
      tui.serverPermissions.set(SES_A, [...(tui.permissions.get(SES_A) ?? [])])
      await pump(tui, [
        { type: 'server.connected', data: {} },
        { type: 'permission.replied', data: { sessionID: SES_A, requestID: 'per_1' } }
      ])
      release()
      await tick(250)
      expect(tui.permissions.get(SES_A)).toHaveLength(1)
      expect(summary(posts).at(-1)).toBe(`SessionBusy:${SES_A}`)
      await cleanup?.()
    })

    // Why: an Orca restart moves the hook endpoint while the pane's level stays the same.
    it('re-posts the current level once the hook endpoint moves', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      await pump(tui, turn(SES_A, 'A').start)
      await tick(200)
      await waitFor(() => expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`]))
      process.env.ORCA_AGENT_HOOK_PORT = '59998'
      await tick(4699)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`])
      await tick(1)
      expect(statuses(posts)).toEqual([`SessionBusy:${SES_A}`, `SessionBusy:${SES_A}`])
      await tick(300)
      await tick(5000)
      await tick(50)
      expect(statuses(posts)).toHaveLength(2)
      await cleanup?.()
    })

    it('does not pin Needs input on a request the data kept after its turn ended', async () => {
      const tui = fakeTui()
      const cleanup = await start(tui)
      tui.navigate(SES_A)
      const a = turn(SES_A, 'A')
      await pump(tui, [...a.start, permission(SES_A)])
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`PermissionRequest:${SES_A}`))
      await pump(tui, a.finish)
      await waitFor(() => expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`))
      await tick(250)
      expect(summary(posts).at(-1)).toBe(`SessionIdle:${SES_A}`)
      await cleanup?.()
    })
  })

  it.each([
    ['an OpenCode 1 TUI', () => fakeTui('1.18.33')],
    ['the other pane variant', () => fakeTui()],
    ['a TUI outside an Orca pane', () => fakeTui()]
  ])('stays silent in %s', async (label, make) => {
    if (label === 'the other pane variant') {
      process.env.ORCA_OPENCODE_AGENT = 'opencode2'
    }
    process.env.ORCA_PANE_KEY = PANE_A
    if (label === 'a TUI outside an Orca pane') {
      delete process.env.ORCA_PANE_KEY
    }
    const tui = make()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    expect(tui.listen).not.toHaveBeenCalled()
    await cleanup?.()
  })

  describe('server plugin stand-down', () => {
    function serverContext() {
      const subscribe = vi.fn(async function* () {})
      const hook = vi.fn(async () => ({ dispose: vi.fn() }))
      return {
        subscribe,
        hook,
        ctx: {
          session: { hook, get: async () => undefined },
          event: { subscribe }
        }
      }
    }
    const installTuiCopy = (): void => {
      mkdirSync(join(tempDir, 'orca-opencode-status-tui'))
      writeFileSync(join(tempDir, 'orca-opencode-status-tui', 'tui.js'), '')
    }

    it('reports nothing from a serve process when the TUI copy is installed beside it', async () => {
      installTuiCopy()
      process.argv = [...savedArgv, 'serve', '--service']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).not.toHaveBeenCalled()
      expect(server.hook).not.toHaveBeenCalled()
      await cleanup?.()
    })

    it('stands down in a --standalone private server too', async () => {
      installTuiCopy()
      process.argv = [...savedArgv, 'serve', '--stdio', '--port', '0']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).not.toHaveBeenCalled()
      await cleanup?.()
    })

    // Why: an older SSH relay installs this file but not the TUI copy; nothing else would report.
    it('keeps reporting from a serve process whose installer wrote no TUI copy', async () => {
      process.argv = [...savedArgv, 'serve', '--service']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).toHaveBeenCalled()
      await cleanup?.()
    })
  })
})
