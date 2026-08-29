// Runs the generated titlebar spinner extension inside a VM sandbox with a
// stubbed pi handle and hook ctx, so specs assert what a real Pi/OMP process
// would render — and what it does when the runtime invalidates either one.
// Mirrors agent-status-extension-test-harness.ts for the sibling extension.
import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { vi } from 'vitest'

import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

export type HookContext = {
  ui: { setTitle: (title: string) => void }
}

export type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

export type Harness = {
  handlers: Record<string, HookHandler>
  /** Titles written through the live ctx, in order. */
  titles: string[]
  setTitle: ReturnType<typeof vi.fn>
  getSessionName: ReturnType<typeof vi.fn>
  /** Invoke a hook with the live ctx (or an explicit replacement ctx). */
  callHook: (name: string, context?: HookContext) => Promise<void>
  /** Build a ctx whose setTitle throws, as pi does once its session is replaced. */
  createStaleContext: () => HookContext
  /** Make the captured `pi` handle throw, as pi's assertActive guard does. */
  staleHandle: () => void
  reviveHandle: (sessionName?: string) => void
  /** `unref` spies for every interval the extension has armed, in order. */
  intervalUnrefs: ReturnType<typeof vi.fn>[]
}

const STALE_CTX_ERROR =
  'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().'

export function createHarness(args?: {
  paneKey?: string
  cwd?: string
  sessionName?: string
}): Harness {
  const cwd = args?.cwd ?? '/Users/me/project'
  let sessionName: string | undefined = args?.sessionName ?? 'work'
  let handleIsStale = false

  const getSessionName = vi.fn(() => {
    if (handleIsStale) {
      throw new Error(STALE_CTX_ERROR)
    }
    return sessionName
  })

  const titles: string[] = []
  const setTitle = vi.fn((title: string) => {
    titles.push(title)
  })

  const module = {
    exports: {} as {
      default?: (pi: {
        getSessionName: () => string | undefined
        on: (name: string, handler: HookHandler) => void
      }) => void
    }
  }

  // Why: the extension unrefs its interval so a cosmetic animation cannot hold a
  // shutting-down agent alive. Spy on the real handle so that stays assertable.
  const intervalUnrefs: ReturnType<typeof vi.fn>[] = []
  const trackedSetInterval = (...params: Parameters<typeof setInterval>): unknown => {
    const handle = setInterval(...params) as unknown as { unref?: () => unknown }
    if (handle && typeof handle === 'object') {
      const original = typeof handle.unref === 'function' ? handle.unref.bind(handle) : () => handle
      const spy = vi.fn(original)
      handle.unref = spy
      intervalUnrefs.push(spy)
    }
    return handle
  }

  const context = {
    module,
    exports: module.exports,
    process: {
      env:
        'paneKey' in (args ?? {}) ? { ORCA_PANE_KEY: args?.paneKey } : { ORCA_PANE_KEY: 'pane-1' },
      cwd: () => cwd
    },
    setInterval: trackedSetInterval,
    clearInterval,
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() }
  } as Record<string, unknown>
  context.globalThis = context

  const output = ts.transpileModule(getPiTitlebarExtensionSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  register({
    getSessionName,
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    }
  })

  const liveContext: HookContext = { ui: { setTitle } }

  return {
    handlers,
    titles,
    setTitle,
    getSessionName,
    callHook: async (name, hookContext) => {
      await handlers[name]?.(undefined, hookContext ?? liveContext)
    },
    createStaleContext: () => ({
      ui: {
        setTitle: () => {
          throw new Error(STALE_CTX_ERROR)
        }
      }
    }),
    staleHandle: () => {
      handleIsStale = true
    },
    reviveHandle: (nextSessionName) => {
      handleIsStale = false
      if (nextSessionName !== undefined) {
        sessionName = nextSessionName
      }
    },
    intervalUnrefs
  }
}
