import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectAgentStatusFromTitle } from '../../shared/agent-status/title/agent-title-status'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

const BRAILLE_RE = /[⠀-⣿]/

type TitlebarContext = {
  ui: { setTitle: (title: string) => void }
  isIdle?: () => boolean
}
type HookHandler = (event?: unknown, context?: TitlebarContext) => Promise<void> | void

type Harness = {
  handlers: Record<string, HookHandler>
  titles: string[]
  lastTitle: () => string | undefined
  callHook: (name: string, event?: unknown) => Promise<void>
}

const CWD = '/repo/orca-app'
const SESSION = 'omp-session'
const IDLE_TITLE = `π - ${SESSION} - orca-app`
const PROMPT_TITLE = `π ! ${SESSION} - orca-app`

function createHarness(
  options: {
    paneKey?: string
    isIdle?: () => boolean
    kind?: PiAgentKind
    processTitle?: string
    cwdImpl?: () => string
    sessionNameImpl?: () => string
    setTitle?: (title: string) => void
    globals?: Record<string | symbol, unknown>
    env?: Record<string, string>
  } = {}
): Harness {
  const titles: string[] = []
  const ctx: TitlebarContext = {
    ui: {
      setTitle: (title: string) => {
        options.setTitle?.(title)
        titles.push(title)
      }
    },
    isIdle: options.isIdle
  }

  const module = {
    exports: {} as {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        getSessionName: () => string
      }) => void
    }
  }

  const context = {
    module,
    exports: module.exports,
    process: {
      env: { ORCA_PANE_KEY: options.paneKey ?? 'pane-1', ...options.env },
      pid: options.env?.ORCA_PI_TITLE_MARKER_OWNED === undefined ? 111 : 222,
      title: options.processTitle ?? 'pi',
      argv: ['node', 'pi'],
      cwd: options.cwdImpl ?? (() => CWD)
    },
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    Promise,
    // Why: forward to the test realm's timers so vi.useFakeTimers() drives the VM's interval.
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
  } as Record<string, unknown>
  context.globalThis = options.globals ?? context

  const output = ts.transpileModule(getPiTitlebarExtensionSource(options.kind ?? 'pi'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  register({
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    },
    getSessionName: options.sessionNameImpl ?? (() => SESSION)
  })

  return {
    handlers,
    titles,
    lastTitle: () => titles.at(-1),
    callHook: async (name, event) => {
      const handler = handlers[name]
      if (!handler) {
        throw new Error(`no handler registered for ${name}`)
      }
      await handler(event, ctx)
    }
  }
}

describe('getPiTitlebarExtensionSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not let a stale idle-compaction completion stop a newer run', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('marks a mid-turn dialog as needing input and holds it against the spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    expect(detectAgentStatusFromTitle(PROMPT_TITLE)).toBe('permission')

    await vi.advanceTimersByTimeAsync(800)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not strand the marker when the closing ctx throws on ui access', async () => {
    const harness = createHarness()
    // Pi ctx.ui throws after session replacement invalidates its runner.
    const stale = {
      get ui(): never {
        throw new Error('This extension ctx is stale')
      }
    }

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await expect(harness.handlers.ui_prompt_end?.({}, stale as never)).resolves.toBeUndefined()
    expect(harness.lastTitle()).toBe(IDLE_TITLE)

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('leaves the needs-input marker to the process that owns the pane', async () => {
    // Child agents inherit pane identity; only its owning process may assert needs-input.
    const harness = createHarness({ env: { ORCA_PI_TITLE_MARKER_OWNED: '111' } })

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.titles).not.toContain(PROMPT_TITLE)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('reload replaces only its pane owner and ignores late old-generation events', async () => {
    const globals = {}
    const old = createHarness({ globals, isIdle: () => false })
    const other = createHarness({ globals, paneKey: 'pane-2' })
    await old.callHook('agent_start')
    await old.callHook('ui_prompt_start')
    await old.callHook('agent_end')
    await other.callHook('agent_start')
    const replacement = createHarness({ globals })
    await replacement.callHook('session_start', { reason: 'reload' })
    expect(vi.getTimerCount()).toBe(1)
    await replacement.callHook('agent_start')
    const oldCount = old.titles.length
    await old.callHook('session_shutdown')
    await old.callHook('agent_start')
    vi.advanceTimersByTime(80)
    expect(old.titles).toHaveLength(oldCount)
    expect(vi.getTimerCount()).toBe(2)
    expect(replacement.lastTitle()).toMatch(BRAILLE_RE)
    expect(other.lastTitle()).toMatch(BRAILLE_RE)
    const third = createHarness({ globals })
    await third.callHook('session_start', { reason: 'new' })
    expect(vi.getTimerCount()).toBe(1)
    await third.callHook('agent_start')
    await replacement.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(2)
  })

  it('keeps the lead spinner when an in-process subagent session starts', async () => {
    const globals = {}
    const lead = createHarness({ globals, isIdle: () => false })
    await lead.callHook('agent_start')
    const child = createHarness({ globals })
    await child.callHook('session_start', { reason: 'startup' })
    await child.callHook('agent_start')
    const before = lead.titles.length
    vi.advanceTimersByTime(160)
    expect(lead.titles.length).toBeGreaterThan(before)
    expect(child.titles).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
  })
})
