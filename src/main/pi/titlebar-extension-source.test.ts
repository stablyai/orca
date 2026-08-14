import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

type HookContext = {
  ui: {
    setTitle: (title: string) => void
  }
}

type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

type Harness = {
  handlers: Record<string, HookHandler>
  setTitle: ReturnType<typeof vi.fn>
  callHook: (name: string) => Promise<void>
}

function createHarness(args: {
  paneKey?: string
  cwd?: string
  getSessionName: () => string | undefined
}): Harness {
  const handlers: Record<string, HookHandler> = {}
  const setTitle = vi.fn()
  const module = {
    exports: {} as { default?: (pi: { on: (name: string, handler: HookHandler) => void }) => void }
  }
  const context = {
    module,
    exports: module.exports,
    process: {
      env: { ORCA_PANE_KEY: args.paneKey },
      cwd: () => args.cwd ?? '/Users/me/project'
    },
    setInterval,
    clearInterval
  } as Record<string, unknown>
  context.globalThis = context

  // Why: generated spinner source is JS; rewrite the ESM default so vm can load it.
  const output = getPiTitlebarExtensionSource().replace(
    /^export default function/m,
    'module.exports.default = function'
  )
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  register({
    getSessionName: args.getSessionName,
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    }
  } as { on: (name: string, handler: HookHandler) => void })

  const hookContext: HookContext = { ui: { setTitle } }
  return {
    handlers,
    setTitle,
    callHook: async (name) => {
      await handlers[name]?.(undefined, hookContext)
    }
  }
}

describe('getPiTitlebarExtensionSource', () => {
  it('does not register hooks without ORCA_PANE_KEY', () => {
    const harness = createHarness({
      paneKey: undefined,
      getSessionName: () => 'session'
    })
    expect(harness.handlers).toEqual({})
  })

  it('animates the title while the agent is running', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({
        paneKey: 'pane-1',
        getSessionName: () => 'work'
      })

      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(80)

      expect(harness.setTitle.mock.calls.some(([title]) => String(title).includes('π - work - project'))).toBe(
        true
      )
      expect(vi.getTimerCount()).toBe(1)

      await harness.callHook('agent_end')
      expect(vi.getTimerCount()).toBe(0)
      expect(harness.setTitle).toHaveBeenLastCalledWith('π - work - project')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the spinner when getSessionName throws after session replace', async () => {
    vi.useFakeTimers()
    try {
      let stale = false
      const harness = createHarness({
        paneKey: 'pane-1',
        getSessionName: () => {
          if (stale) {
            throw new Error(
              'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx'
            )
          }
          return 'work'
        }
      })

      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(80)
      const titlesBeforeStale = harness.setTitle.mock.calls.length
      expect(titlesBeforeStale).toBeGreaterThan(0)

      stale = true
      await vi.advanceTimersByTimeAsync(80)
      expect(vi.getTimerCount()).toBe(0)
      expect(harness.setTitle.mock.calls.length).toBe(titlesBeforeStale)

      await vi.advanceTimersByTimeAsync(240)
      expect(harness.setTitle.mock.calls.length).toBe(titlesBeforeStale)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reject session_shutdown when the captured pi is already stale', async () => {
    const harness = createHarness({
      paneKey: 'pane-1',
      getSessionName: () => {
        throw new Error('This extension ctx is stale after session replacement or reload.')
      }
    })

    await expect(harness.callHook('session_shutdown')).resolves.toBeUndefined()
    expect(harness.setTitle).not.toHaveBeenCalled()
  })
})
