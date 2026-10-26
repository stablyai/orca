import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
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

  it('registers nothing outside an Orca pane', () => {
    expect(createHarness({ paneKey: '' }).handlers).toEqual({})
  })

  it('stops the spinner when the agent settles', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    expect(vi.getTimerCount()).toBe(1)

    await harness.callHook('agent_settled')

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(harness.lastTitle()).not.toMatch(BRAILLE_RE)

    const titleCountAtSettle = harness.titles.length
    vi.advanceTimersByTime(800)
    expect(harness.titles.length).toBe(titleCountAtSettle)
  })

  it('spins for idle auto-compaction and clears it on completion', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)

    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('caps the idle-maintenance spinner when no completion event arrives', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('does not cap an agent-owned spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('keeps spinning through threshold compaction inside an active run', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'threshold' })
    await harness.callHook('auto_compaction_end', { reason: 'threshold' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not let an idle compaction adopt an already-running agent spinner', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('auto_compaction_end', { reason: 'idle' })

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
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

  it('transfers an idle-compaction spinner to a new run without publishing idle', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    vi.advanceTimersByTime(80)
    const titleCountBeforeTransfer = harness.titles.length

    await harness.callHook('agent_start')

    const transferTitles = harness.titles.slice(titleCountBeforeTransfer)
    expect(transferTitles).not.toContain(IDLE_TITLE)
    expect(transferTitles).toHaveLength(1)
    expect(transferTitles[0]).toMatch(BRAILLE_RE)
  })

  it.each([{ kind: 'omp' as const }, { processTitle: 'omp' }])(
    'stops final OMP completion without waiting for isIdle: %j',
    async (options) => {
      const isIdle = vi.fn(() => false)
      const harness = createHarness({ ...options, isIdle })
      await harness.callHook('agent_start')
      await harness.callHook('agent_end', { willContinue: false })
      const completedTitle = harness.lastTitle()
      expect(completedTitle).not.toMatch(BRAILLE_RE)
      await vi.advanceTimersByTimeAsync(1000)
      expect(harness.lastTitle()).toBe(completedTitle)
      expect(isIdle).not.toHaveBeenCalled()
    }
  )

  it('keeps spinning across a non-terminal OMP agent_end', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('agent_end', { willContinue: true })

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('waits for modern runtimes to become idle after agent_end', async () => {
    let idle = false
    const harness = createHarness({ isIdle: () => idle })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)

    idle = true
    await vi.advanceTimersByTimeAsync(200)
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('still stops on legacy agent_end and on session shutdown', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)

    await harness.callHook('agent_start')
    await harness.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
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

  it('returns an idle pane to its plain title when the dialog closes', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only the outermost of nested dialogs moves the title', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('ignores an unmatched dialog close', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    const titleCount = harness.titles.length
    await harness.callHook('ui_prompt_end')
    expect(harness.titles.length).toBe(titleCount)
  })

  it.each(['agent_settled', 'session_shutdown'])(
    'keeps the marker when %s lands under an open dialog',
    async (name) => {
      const harness = createHarness()

      await harness.callHook('agent_start')
      await harness.callHook('ui_prompt_start')
      await harness.callHook(name)
      const expected = name === 'session_shutdown' ? IDLE_TITLE : PROMPT_TITLE
      expect(harness.lastTitle()).toBe(expected)
      // Pi may overwrite titles independently; keep reasserting the open-dialog marker after settling.
      expect(vi.getTimerCount()).toBe(name === 'session_shutdown' ? 0 : 1)
    }
  )

  it('keeps the marker across an idle compaction that finishes under a dialog', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('auto_compaction_end')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('recovers the spinner on a new turn when a dialog close was lost', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('leaves the marker to OMP approval events instead of painting it', () => {
    expect(createHarness({ kind: 'omp' }).handlers.ui_prompt_start).toBeUndefined()
  })

  it('still caps idle maintenance while a dialog holds the title', async () => {
    const harness = createHarness()

    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    await harness.callHook('ui_prompt_start')
    vi.advanceTimersByTime(301_000)

    expect(vi.getTimerCount()).toBe(1)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('survives a dialog event that carries no ui context', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await expect(harness.handlers.ui_prompt_start?.({}, undefined)).resolves.toBeUndefined()
    await expect(harness.handlers.ui_prompt_end?.({}, undefined)).resolves.toBeUndefined()
  })

  it('keeps spinning when the dialog event could not paint the marker', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.handlers.ui_prompt_start?.({}, undefined)
    // Without a painted marker, suppressing frames would leave a working spinner frozen.
    await vi.advanceTimersByTimeAsync(160)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('marks a nested dialog when the outer one could not paint', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.handlers.ui_prompt_start?.({}, undefined)
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('clears the marker through the opening ctx when the close carries none', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    await harness.handlers.ui_prompt_end?.({}, undefined)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
  })

  it('does not reject when the dialog ctx can no longer paint', async () => {
    const harness = createHarness()
    const throwing = {
      ui: {
        setTitle: () => {
          throw new Error('extension runner is no longer active')
        }
      }
    }

    await expect(harness.handlers.ui_prompt_start?.({}, throwing)).resolves.toBeUndefined()
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('does not reject when the captured ctx dies before the dialog closes', async () => {
    const harness = createHarness()
    let live = true
    const dying = {
      ui: {
        setTitle: (title: string) => {
          if (!live) {
            throw new Error('extension runner is no longer active')
          }
          harness.titles.push(title)
        }
      }
    }

    await harness.handlers.ui_prompt_start?.({}, dying)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    live = false
    await expect(harness.handlers.ui_prompt_end?.({}, undefined)).resolves.toBeUndefined()
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
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

  it('does not reject when the opening ctx throws on ui access', async () => {
    const harness = createHarness()
    const stale = {
      get ui(): never {
        throw new Error('This extension ctx is stale')
      }
    }

    await harness.callHook('agent_start')
    await expect(harness.handlers.ui_prompt_start?.({}, stale as never)).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('re-asserts the marker when pi repaints the title under a dialog', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    // Pi rewrites titles on session_info_changed/rebindCurrentSession without an event visible here.
    harness.titles.push('π - other - orca-app')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
  })

  it('re-asserts the marker on an idle pane with no spinner running', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    // Idle has no renderFrame; only slow reassertion can repair Pi's independent title writes.
    harness.titles.push('\u03c0 - other - orca-app')
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the marker when a session replacement drops the dialog', async () => {
    const harness = createHarness()

    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)

    // Session replacement hides dialogs without emitting close.
    await harness.callHook('session_start', { reason: 'switch' })
    expect(vi.getTimerCount()).toBe(0)
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
  })

  it('survives a deleted cwd instead of crashing the pi process', async () => {
    const harness = createHarness({
      cwdImpl: () => {
        throw new Error('ENOENT: uv_cwd')
      }
    })

    // Timer callback errors reach Pi's uncaughtException handler and exit the agent.
    await expect(harness.callHook('agent_start')).resolves.toBeUndefined()
    await expect(harness.callHook('ui_prompt_start')).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(harness.callHook('ui_prompt_end')).resolves.toBeUndefined()
    await expect(harness.callHook('agent_settled')).resolves.toBeUndefined()
  })

  it('survives a session name that throws on a stale runtime', async () => {
    let live = true
    const harness = createHarness({
      sessionNameImpl: () => {
        if (!live) {
          throw new Error('This extension API is stale')
        }
        return SESSION
      }
    })

    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    live = false
    await vi.advanceTimersByTimeAsync(2000)
    await expect(harness.callHook('ui_prompt_end')).resolves.toBeUndefined()
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

  it('leaves an OMP runtime to its own approval events', () => {
    const harness = createHarness({ processTitle: 'omp' })

    expect(harness.handlers.ui_prompt_start).toBeDefined()
    expect(() => harness.handlers.ui_prompt_start?.({}, undefined)).not.toThrow()
  })

  it.each(['getter', 'title'] as const)(
    'retires a stale %s during animation without throwing or rescheduling',
    async (failure) => {
      let stale = false
      const harness = createHarness({
        sessionNameImpl: () => {
          if (stale && failure === 'getter') {
            throw new Error('expired session')
          }
          return SESSION
        },
        setTitle: () => {
          if (stale && failure === 'title') {
            throw new Error('expired UI')
          }
        }
      })
      await harness.callHook('agent_start')
      stale = true
      expect(() => vi.advanceTimersByTime(80)).not.toThrow()
      expect(vi.getTimerCount()).toBe(0)
      await harness.callHook('agent_start')
      expect(vi.getTimerCount()).toBe(0)
      stale = false
      await harness.callHook('agent_start')
      expect(vi.getTimerCount()).toBe(1)
    }
  )

  it.each(['getter', 'title'] as const)('contains stale %s during shutdown', async (failure) => {
    let stale = false
    const harness = createHarness({
      sessionNameImpl: () => {
        if (stale && failure === 'getter') {
          throw new Error('expired session')
        }
        return SESSION
      },
      setTitle: () => {
        if (stale && failure === 'title') {
          throw new Error('expired UI')
        }
      },
      isIdle: () => false
    })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    stale = true
    await expect(harness.callHook('session_shutdown')).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule a timer when the first frame fails', async () => {
    const harness = createHarness({
      sessionNameImpl: () => {
        throw new Error('expired')
      }
    })
    await harness.callHook('agent_start')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires animation when an idle recheck loses its session', async () => {
    const harness = createHarness({
      isIdle: () => {
        throw new Error('expired')
      }
    })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    expect(() => vi.advanceTimersByTime(1)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears animation and pending idle checks on session replacement', async () => {
    const harness = createHarness({ isIdle: () => false })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    await harness.callHook('session_shutdown')
    await harness.callHook('session_start')
    expect(vi.getTimerCount()).toBe(0)
    await harness.callHook('agent_start')
    expect(vi.getTimerCount()).toBe(1)
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
    expect(vi.getTimerCount()).toBe(1)
    await third.callHook('agent_start')
    await replacement.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(2)
  })

  it('stops spinner, prompt reassertion and idle recheck together on invalidation', async () => {
    let stale = false
    const harness = createHarness({
      isIdle: () => false,
      sessionNameImpl: () => {
        if (stale) {
          throw new Error('stale generation')
        }
        return SESSION
      }
    })
    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(3)
    stale = true
    await vi.advanceTimersByTimeAsync(80)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears prompt and idle timers at session_start without needing shutdown', async () => {
    const harness = createHarness({ isIdle: () => false })
    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(3)
    await harness.callHook('session_start')
    expect(vi.getTimerCount()).toBe(0)
    await harness.callHook('agent_start')
    expect(harness.lastTitle()).toMatch(BRAILLE_RE)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('paints the rest title at session_start so a branded Pi reads as ready before its first turn', async () => {
    const harness = createHarness()
    await harness.callHook('session_start', { reason: 'startup' })
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a leftover needs-input marker when session_start replaces the session', async () => {
    const harness = createHarness()
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    await harness.callHook('session_start', { reason: 'switch' })
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ kind: 'omp' as const }, { processTitle: 'omp' }])(
    'leaves OMP its native startup title so readiness waits out its setup wizard: %j',
    async (options) => {
      const harness = createHarness(options)
      await harness.callHook('session_start', { reason: 'startup' })
      expect(harness.titles).toEqual([])
    }
  )
})
