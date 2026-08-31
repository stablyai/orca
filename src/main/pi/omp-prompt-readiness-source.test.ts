import { webcrypto } from 'node:crypto'
import { TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it, vi } from 'vitest'

import {
  getOmpPromptReadinessExtensionSource,
  getOmpPromptReadinessSourceLines
} from './omp-prompt-readiness-source'
import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

type Component = {
  render: (width: number) => string[]
  invalidate: () => void
  dispose?: () => void
}

type Composer = {
  pendingImages: unknown[]
  pendingImageLinks: unknown[]
  getExpandedText: () => string
  getText: () => string
  clearDraft: () => void
  disableSubmit: boolean
}

type Harness = {
  output: string[]
  handlers: Record<string, (event: unknown, context: unknown) => void>
  start: (context: ReturnType<typeof createContext>) => void
  shutdown: (context: ReturnType<typeof createContext>) => void
  shutdownAt: (index: number, context: ReturnType<typeof createContext>) => void
  beforeAgentStart: (event?: unknown) => Promise<void>
  beforeAgentStartAt: (index: number, event?: unknown) => Promise<void>
  input: (event: unknown) => Promise<void>
  inputAt: (index: number, event: unknown) => Promise<void>
  render: () => string[]
  runTimers: () => void
  widgetPlacement: () => unknown
  disposeWidget: (index: number) => void
  reload: () => void
  settle: () => Promise<void>
}

type OmpSettingsModule = {
  Settings?: {
    instance?: {
      override?: (key: string, value: unknown) => void
      set?: (key: string, value: unknown) => void
    }
  }
}

function createOmpSettingsModule() {
  const persisted: Record<string, unknown> = {
    'paste.largeMenuThreshold': 100,
    model: 'unchanged-model',
    permission: 'ask'
  }
  const overrides: Record<string, unknown> = {}
  let persistedWrites = 0
  let overridesApplied = 0
  const module: OmpSettingsModule = {
    Settings: {
      instance: {
        override(key, value) {
          overridesApplied += 1
          overrides[key] = value
        },
        set(key, value) {
          persistedWrites += 1
          persisted[key] = value
        }
      }
    }
  }
  return {
    module,
    paste(text: string) {
      const threshold =
        overrides['paste.largeMenuThreshold'] ?? persisted['paste.largeMenuThreshold']
      const lines = text.split('\n').length
      return Number(threshold) > 0 && lines >= Number(threshold)
        ? { selector: true }
        : { selector: false, attachmentText: text }
    },
    settings: persisted,
    overrideCount: () => overridesApplied,
    persistedWriteCount: () => persistedWrites
  }
}

function createComposer(disableSubmit: boolean): Composer {
  return {
    pendingImages: [],
    pendingImageLinks: [],
    getExpandedText: () => '',
    getText: () => '',
    clearDraft: () => {},
    disableSubmit
  }
}

function createContext(args: {
  focused: () => unknown
  overlayStack?: unknown
  isIdle?: () => boolean
}): {
  isIdle: () => boolean
  ui: {
    setWidget: ReturnType<typeof vi.fn>
  }
  tui: {
    getFocused: () => unknown
    overlayStack: unknown
    requestRender: ReturnType<typeof vi.fn>
  }
} {
  const tui = {
    getFocused: args.focused,
    overlayStack: args.overlayStack ?? [],
    requestRender: vi.fn()
  }
  return {
    isIdle: args.isIdle ?? (() => true),
    ui: {
      setWidget: vi.fn()
    },
    tui
  }
}

function createHarness(options?: {
  crypto?: unknown
  ompSettingsModule?: unknown
  source?: string
}): Harness {
  const output: string[] = []
  const timers: (() => void)[] = []
  const handlers: Record<string, (event: unknown, context: unknown) => void> = {}
  const shutdownHandlers: ((event: unknown, context: unknown) => void)[] = []
  const beforeAgentStartHandlers: ((event: unknown) => unknown)[] = []
  const inputHandlers: ((event: unknown) => unknown)[] = []
  const widgets: Component[] = []
  let widget: Component | undefined
  let widgetPlacement: unknown

  const module = {
    exports: {} as {
      default?: (pi: {
        on: (name: string, handler: (event: unknown, context: unknown) => void) => void
      }) => void
    }
  }
  const processMock = {
    pid: 42,
    env: { ORCA_PANE_KEY: 'pane-1' },
    stdout: { write: (value: string) => output.push(value) }
  }
  const setTimeoutMock = vi.fn((callback: () => void) => {
    timers.push(callback)
    return { unref: vi.fn() }
  })
  const context = {
    module,
    exports: module.exports,
    process: processMock,
    require(specifier: string) {
      if (specifier === '@oh-my-pi/pi-coding-agent') {
        return options?.ompSettingsModule ?? { Settings: { instance: { override() {} } } }
      }
      throw new Error(`unexpected require(${specifier})`)
    },
    crypto: options?.crypto ?? webcrypto,
    TextEncoder,
    setTimeout: setTimeoutMock,
    clearTimeout: vi.fn()
  } as Record<string, unknown>
  context.globalThis = context

  const source =
    options?.source ??
    `${getOmpPromptReadinessSourceLines().join('\n')}\nexport default installOmpPromptReadiness\n`
  const outputJs = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(outputJs, context)

  const install = module.exports.default
  if (!install) {
    throw new Error('expected generated readiness source default export')
  }
  const register = (): void => {
    install({
      on(name, handler) {
        handlers[name] = handler
        if (name === 'session_shutdown') {
          shutdownHandlers.push(handler)
        }
        if (name === 'before_agent_start') {
          beforeAgentStartHandlers.push(handler as (event: unknown) => unknown)
        }
        if (name === 'input') {
          inputHandlers.push(handler as (event: unknown) => unknown)
        }
      }
    })
  }
  register()

  return {
    output,
    handlers,
    start(context) {
      handlers.session_start?.({}, context)
      const call = context.ui.setWidget.mock.calls.at(-1)
      widgetPlacement = call?.[2]
      const previous = widget
      widget = call?.[1]?.(context.tui)
      if (widget) {
        widgets.push(widget)
      }
      previous?.dispose?.()
    },
    shutdown(context) {
      handlers.session_shutdown?.({}, context)
    },
    shutdownAt(index, context) {
      shutdownHandlers[index]?.({}, context)
    },
    async beforeAgentStart(event = {}) {
      await handlers.before_agent_start?.(event, {})
    },
    async beforeAgentStartAt(index, event = {}) {
      await beforeAgentStartHandlers[index]?.(event)
    },
    async input(event) {
      await handlers.input?.(event, {})
    },
    async inputAt(index, event) {
      await inputHandlers[index]?.(event)
    },
    render: () => widget?.render(80) ?? [],
    runTimers: () => {
      for (const timer of timers.splice(0)) {
        timer()
      }
    },
    widgetPlacement: () => widgetPlacement,
    disposeWidget: (index) => {
      widgets[index]?.dispose?.()
    },
    reload: register,
    async settle() {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve()
      }
    }
  }
}

function installReadinessOnlyExtension(args: {
  ownerPid?: string
  paneKey?: string
  ompSettingsModule?: OmpSettingsModule
}): Pick<Harness, 'output' | 'handlers' | 'settle'> & { env: Record<string, string> } {
  const output: string[] = []
  const handlers: Harness['handlers'] = {}
  const env = {
    ...(args.ownerPid ? { ORCA_PI_STATUS_OWNED: args.ownerPid } : {}),
    ...(args.paneKey ? { ORCA_PANE_KEY: args.paneKey } : {})
  }
  const module = {
    exports: {} as {
      default?: (pi: {
        on: (name: string, handler: (event: unknown, context: unknown) => void) => void
      }) => void
    }
  }
  const context = {
    module,
    exports: module.exports,
    process: {
      pid: 42,
      env,
      stdout: { write: (value: string) => output.push(value) }
    },
    require(specifier: string) {
      if (specifier === '@oh-my-pi/pi-coding-agent') {
        return args.ompSettingsModule ?? { Settings: { instance: { override() {} } } }
      }
      throw new Error(`unexpected require(${specifier})`)
    },
    setTimeout,
    clearTimeout
  } as Record<string, unknown>
  context.globalThis = context
  const outputJs = ts.transpileModule(getOmpPromptReadinessExtensionSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(outputJs, context)
  module.exports.default?.({
    on(name, handler) {
      handlers[name] = handler
    }
  })
  return {
    output,
    handlers,
    env,
    async settle() {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve()
      }
    }
  }
}

describe('getOmpPromptReadinessSourceLines', () => {
  it('disables every managed large-paste selector without changing persisted model or permission settings', async () => {
    const omp = createOmpSettingsModule()
    const harness = createHarness({ ompSettingsModule: omp.module })

    await harness.settle()

    for (const lineCount of [99, 100, 101]) {
      const text = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join('\n')
      expect(omp.paste(text)).toEqual({ selector: false, attachmentText: text })
    }
    expect(omp.settings).toEqual({
      'paste.largeMenuThreshold': 100,
      model: 'unchanged-model',
      permission: 'ask'
    })
    expect(omp.persistedWriteCount()).toBe(0)
  })

  it('keeps readiness blocked when the installed OMP settings API is unavailable', async () => {
    const composer = createComposer(false)
    const harness = createHarness({ ompSettingsModule: {} })
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()

    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('requests a TUI render when settings finish loading after the first readiness render', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    harness.start(context)
    harness.render()
    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])

    await harness.settle()

    expect(context.tui.requestRender).toHaveBeenCalledTimes(1)
    harness.render()
    harness.runTimers()
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])
  })

  it('wakes the current sentinel when settings resolve after an extension reload', async () => {
    const omp = createOmpSettingsModule()
    let resolveModule: (module: OmpSettingsModule) => void
    const delayedModule = Object.assign(
      new Promise<OmpSettingsModule>((resolve) => {
        resolveModule = resolve
      }),
      { __esModule: true }
    )
    const harness = createHarness({ ompSettingsModule: delayedModule })
    const firstComposer = createComposer(false)
    const secondComposer = createComposer(false)
    const firstContext = createContext({ focused: () => firstComposer })
    const secondContext = createContext({ focused: () => secondComposer })

    harness.start(firstContext)
    harness.render()
    harness.reload()
    harness.start(secondContext)
    harness.render()
    resolveModule!(omp.module)
    await harness.settle()

    expect(firstContext.tui.requestRender).not.toHaveBeenCalled()
    expect(secondContext.tui.requestRender).toHaveBeenCalledTimes(1)
    harness.render()
    harness.runTimers()
    expect(harness.output).toContain('\x1b]777;orca-omp-prompt;ready\x07')
  })

  it('uses the same in-memory override in the hooks-disabled extension', async () => {
    const omp = createOmpSettingsModule()
    const extension = installReadinessOnlyExtension({
      paneKey: 'pane-1',
      ompSettingsModule: omp.module
    })

    await extension.settle()
    const originalText = Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join('\n')

    expect(omp.paste(originalText)).toEqual({ selector: false, attachmentText: originalText })
    expect(extension.handlers.session_start).toBeTypeOf('function')
    expect(omp.persistedWriteCount()).toBe(0)
  })

  it('uses the in-memory override before the full owned OMP extension registers readiness', async () => {
    const omp = createOmpSettingsModule()
    const extension = createHarness({
      ompSettingsModule: omp.module,
      source: getPiAgentStatusExtensionSource('omp')
    })
    const originalText = Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join('\n')

    await extension.settle()

    expect(omp.paste(originalText)).toEqual({ selector: false, attachmentText: originalText })
    expect(extension.handlers.session_start).toBeTypeOf('function')
    expect(omp.persistedWriteCount()).toBe(0)
  })

  it('keeps the single process override across an extension reload', async () => {
    const omp = createOmpSettingsModule()
    const harness = createHarness({ ompSettingsModule: omp.module })

    await harness.settle()
    harness.reload()
    await harness.settle()

    expect(omp.overrideCount()).toBe(1)
    expect(omp.settings).toEqual({
      'paste.largeMenuThreshold': 100,
      model: 'unchanged-model',
      permission: 'ask'
    })
  })

  it('readiness-only extension keeps OMP ownership and registers no status event handlers', () => {
    const owned = installReadinessOnlyExtension({ ownerPid: 'already-owned', paneKey: 'pane-1' })
    expect(owned.handlers).toEqual({})
    expect(owned.output).toEqual([])

    const owner = installReadinessOnlyExtension({ paneKey: 'pane-1' })
    expect(Object.keys(owner.handlers).sort()).toEqual([
      'before_agent_start',
      'input',
      'session_shutdown',
      'session_start'
    ])
    expect(owner.env.ORCA_PI_STATUS_OWNED).toBe('42')
    expect(owner.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('emits blocked at installation and ready only after the disabled composer becomes submit-enabled', async () => {
    const composer = createComposer(true)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
    await harness.settle()
    harness.start(context)
    expect(harness.widgetPlacement()).toEqual({ placement: 'belowEditor' })
    expect(harness.render()).toEqual([])
    expect(harness.output).toHaveLength(1)

    composer.disableSubmit = false
    expect(harness.render()).toEqual([])
    expect(harness.output).toHaveLength(1)
    harness.runTimers()
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])
  })

  it('emits a submitted hash only when interactive input matches the later agent prompt', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    expect(harness.output).not.toContain('\x1b]777;orca-omp-prompt;submitted\x07')

    await harness.input({ source: 'automation', text: 'hello' })
    await harness.beforeAgentStart()
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])

    await harness.input({ source: 'interactive', text: 'hello' })
    await harness.beforeAgentStart({ prompt: 'different prompt' })
    await harness.beforeAgentStart({ prompt: 'hello' })
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])

    await harness.input({ source: 'interactive', text: 'hello' })
    await harness.beforeAgentStart({ prompt: 'hello' })

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;submitted;2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\x07'
    ])
  })

  it('forgets handled interactive input once the composer becomes ready again', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    await harness.input({ source: 'interactive', text: 'handled command' })
    harness.render()
    harness.runTimers()
    await harness.beforeAgentStart({ prompt: 'handled command' })

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])
  })

  it('does not let a stale asynchronous submission digest emit after reload or shutdown', async () => {
    const composer = createComposer(false)
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined
    const harness = createHarness({
      crypto: {
        subtle: {
          digest: () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveDigest = resolve
            })
        }
      }
    })
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    await harness.input({ source: 'interactive', text: 'first' })
    const oldSubmission = harness.beforeAgentStartAt(0, { prompt: 'first' })
    expect(resolveDigest).toBeTypeOf('function')
    harness.reload()
    resolveDigest!(new Uint8Array(32).buffer)
    await oldSubmission
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])

    harness.start(context)
    await harness.input({ source: 'interactive', text: 'second' })
    harness.shutdown(context)
    await harness.beforeAgentStart({ prompt: 'second' })
    expect(harness.output).not.toContain('\x1b]777;orca-omp-prompt;submitted\x07')
  })

  it('fails closed when an overlay owns focus instead of the composer', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => ({ disableSubmit: false }), overlayStack: [{}] })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()

    expect(composer.disableSubmit).toBe(false)
    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('fails closed for a focused object without the complete OMP composer shape', async () => {
    const harness = createHarness()
    const context = createContext({
      focused: () => ({ pendingImages: [], disableSubmit: false, getText: () => '' })
    })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()

    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('returns to blocked when the captured composer is no longer idle', async () => {
    const composer = createComposer(false)
    let idle = true
    const harness = createHarness()
    const context = createContext({ focused: () => composer, isIdle: () => idle })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    idle = false
    harness.render()

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])
  })

  it('does not accept a different full composer after capturing the startup composer', async () => {
    const startupComposer = createComposer(true)
    const replacementComposer = createComposer(false)
    let focused: unknown = startupComposer
    const harness = createHarness()
    const context = createContext({ focused: () => focused })

    await harness.settle()
    harness.start(context)
    harness.render()
    focused = replacementComposer
    harness.render()
    harness.runTimers()

    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('emits blocked when a ready session shuts down', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    harness.shutdown(context)

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])
  })

  it('lets only the active widget disposal revoke ready after a replacement', async () => {
    const first = createComposer(false)
    const second = createComposer(false)
    const harness = createHarness()
    const firstContext = createContext({ focused: () => first })
    const secondContext = createContext({ focused: () => second })

    await harness.settle()
    harness.start(firstContext)
    harness.render()
    harness.runTimers()
    harness.start(secondContext)
    harness.render()
    harness.runTimers()
    harness.disposeWidget(0)

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])

    harness.disposeWidget(1)
    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])
  })

  it('invalidates an old sentinel immediately on reload before the next session starts', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    harness.reload()
    harness.render()
    harness.runTimers()

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07'
    ])
  })

  it('does not let a stale session shutdown remove the current widget', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.reload()
    harness.start(context)
    harness.shutdownAt(0, context)

    expect(context.ui.setWidget.mock.calls.at(-1)?.[1]).toBeTypeOf('function')
  })

  it('cancels a queued ready emission when the session shuts down', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.shutdown(context)
    harness.runTimers()

    expect(harness.output).toEqual(['\x1b]777;orca-omp-prompt;blocked\x07'])
  })

  it('reinstalls a fresh sentinel after reload and accepts an already-enabled full composer', async () => {
    const composer = createComposer(false)
    const harness = createHarness()
    const context = createContext({ focused: () => composer })

    await harness.settle()
    harness.start(context)
    harness.render()
    harness.runTimers()
    harness.reload()
    harness.start(context)
    harness.render()
    harness.runTimers()

    expect(harness.output).toEqual([
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07',
      '\x1b]777;orca-omp-prompt;blocked\x07',
      '\x1b]777;orca-omp-prompt;ready\x07'
    ])
  })
})
