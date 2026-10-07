import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { vi } from 'vitest'

import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

export type HookContext = {
  hasUI?: boolean
  ui?: { setEditorText?: (text: string) => void; notify?: (message: string, level: string) => void }
  isIdle?: () => boolean
  model?: { provider?: unknown; id?: unknown } | null
  modelRegistry?: { getAvailable: () => { provider: string; id: string }[] }
  sessionManager?: {
    getSessionId?: () => unknown
    getSessionFile?: () => unknown
    getHeader?: () => unknown
  }
}

type PiEventBus = {
  on: (name: string, listener: (event: unknown) => void) => unknown
}

export type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

type FakeCurlChild = {
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

export type AgentStatusExtensionHarness = {
  setModelMock: ReturnType<typeof vi.fn>
  commands: Record<string, { handler: (args: string, context: HookContext) => Promise<void> }>
  killMock: ReturnType<typeof vi.fn>
  fetchMock: ReturnType<typeof vi.fn>
  spawnMock: ReturnType<typeof vi.fn>
  spawnedChildren: FakeCurlChild[]
  fsMock: {
    existsSync: ReturnType<typeof vi.fn>
    readFileSync: ReturnType<typeof vi.fn>
    statSync: ReturnType<typeof vi.fn>
  }
  handlers: Record<string, HookHandler>
  processEnv: Record<string, string | undefined>
  callHook: (name: string, event?: unknown, context?: HookContext) => Promise<void>
  emitPiEvent: (name: string, event: unknown) => void
  piEventListenerCount: (name: string) => number
  // Re-run the factory on the same event bus and module state.
  reload: () => void
  // What Pi does for /new, resume and fork: shut the old registration down, drop its bus
  // subscriptions, then run the factory again on a fresh `pi.events` (module state kept).
  replacePiSession: (reason: 'new' | 'resume' | 'fork', targetSessionFile?: string) => Promise<void>
  // What Pi does for /reload: as above, but the module is evaluated again and `globalThis` survives.
  reloadPi: () => Promise<void>
  // An OMP in-process task child: the same module's factory, run again on the child's own bus.
  // Returns an emitter for events on that child's bus.
  registerTaskChild: () => (name: string, event: unknown) => void
}

const BASE_ENV = {
  ORCA_PANE_KEY: 'pane-1',
  ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
  ORCA_TAB_ID: 'tab-1',
  ORCA_WORKTREE_ID: 'tree-1',
  ORCA_AGENT_HOOK_PORT: '4321',
  ORCA_AGENT_HOOK_TOKEN: 'token-1',
  ORCA_AGENT_HOOK_ENV: 'env-1',
  ORCA_AGENT_HOOK_VERSION: '1.2.3'
} satisfies Record<string, string>

// Why: ownership keys on process.pid, so reload and child-process tests need
// stable, distinct identities.
export const AGENT_STATUS_EXTENSION_SELF_PID = 4242

export function createAgentStatusExtensionHarness(args: {
  kind: 'pi' | 'omp' | 'prime-agent'
  killImpl?: (pid: number, signal: number) => void
  env?: Record<string, string | undefined>
  pid?: number
  title?: string
  argv?: readonly string[]
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: string) => string
  statSync?: (path: string) => { mtimeMs: number; size: number; ino: number }
  curlExitCode?: number | null
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
  // Runs before the first registration, to leave state an older build would have put on the bus.
  seedEventBus?: (bus: EventEmitter) => void
  // Pi before 0.84 handed every registration the one shared bus.
  sharedEventBus?: boolean
}): AgentStatusExtensionHarness {
  const fetchMock = vi.fn(
    args.fetchImpl ??
      (async () => ({
        ok: true
      }))
  )

  const spawnedChildren: FakeCurlChild[] = []
  const spawnMock = vi.fn(() => {
    const emitter = new EventEmitter()
    const child: FakeCurlChild = {
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(() => emitter.emit('close', null)),
      on: vi.fn(emitter.on.bind(emitter)),
      stdin: {
        on: vi.fn(),
        end: vi.fn()
      }
    }
    spawnedChildren.push(child)
    if (args.curlExitCode !== null) {
      void Promise.resolve().then(() => emitter.emit('close', args.curlExitCode ?? 0))
    }
    return child
  })

  const fsMock = {
    existsSync: vi.fn(args.existsSync ?? (() => false)),
    statSync: vi.fn(
      args.statSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    ),
    readFileSync: vi.fn(
      args.readFileSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    )
  }

  const module: {
    exports: {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        registerCommand: (
          name: string,
          command: { handler: (args: string, context: HookContext) => Promise<void> }
        ) => void
        setModel: (model: unknown) => Promise<boolean>
        events?: PiEventBus
      }) => void
    }
  } = { exports: {} }
  const requireMock = vi.fn((specifier: string) => {
    if (specifier === 'fs') {
      return fsMock
    }
    if (specifier === 'child_process') {
      return { spawn: spawnMock }
    }
    throw new Error(`unexpected require(${specifier})`)
  })

  const killMock = vi.fn(args.killImpl ?? (() => undefined))
  const processMock = {
    kill: killMock,
    env: {
      ...BASE_ENV,
      ...(args.kind === 'prime-agent' ? { PRIME_AGENT_INTERNAL_DAEMON_WORKER: '1' } : {}),
      ...args.env
    },
    pid: args.pid ?? AGENT_STATUS_EXTENSION_SELF_PID,
    title: args.title ?? 'node',
    argv: args.argv ?? ['node', '/usr/bin/orca']
  }

  const context = {
    module,
    exports: module.exports,
    require: requireMock,
    process: processMock,
    fetch: fetchMock,
    console: {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    },
    Promise,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  } as Record<string, unknown>
  context.globalThis = context

  const source = getPiAgentStatusExtensionSource(args.kind)
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText
  createContext(context)
  // Why: a function scope per evaluation, so a Pi reload can evaluate the module again in one realm.
  const evaluateModule = (): NonNullable<typeof module.exports.default> => {
    runInContext(`(function () {\n${output}\n})()`, context)
    const factory = module.exports.default
    if (!factory) {
      throw new Error('expected default export from generated source')
    }
    return factory
  }
  let register = evaluateModule()

  const handlers: Record<string, HookHandler> = {}
  // Why: Pi calls every handler an extension registers for an event, in registration order.
  let handlerLists: Record<string, HookHandler[]> = {}
  let piEvents = new EventEmitter()
  let busSubscriptions: [string, (event: unknown) => void][] = []
  const commands: AgentStatusExtensionHarness['commands'] = {}
  const setModelMock = vi.fn(async (_model: unknown) => true)
  const registerInto = (
    target: Record<string, HookHandler>,
    events: PiEventBus = piEvents
  ): void => {
    handlerLists = {}
    register({
      registerCommand: (name, command) => {
        commands[name] = command
      },
      setModel: setModelMock,
      events,
      on(name: string, handler: HookHandler) {
        target[name] = handler
        ;(handlerLists[name] ??= []).push(handler)
      }
    })
  }
  const callHook: AgentStatusExtensionHarness['callHook'] = async (name, event, hookContext) => {
    for (const handler of handlerLists[name] ?? []) {
      await handler(event, hookContext)
    }
  }
  // Why: each Pi registration gets its own `pi.events` object, and Pi removes its subscriptions when
  // the registration is replaced; anything an extension stores on that object goes with it.
  const registerLikePi = (): void => {
    for (const [name, listener] of busSubscriptions) {
      piEvents.off(name, listener)
    }
    busSubscriptions = []
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    const bus = piEvents
    registerInto(handlers, {
      on(name: string, listener: (event: unknown) => void) {
        bus.on(name, listener)
        busSubscriptions.push([name, listener])
      }
    })
  }
  args.seedEventBus?.(piEvents)
  if (args.kind === 'pi' && !args.sharedEventBus) {
    registerLikePi()
  } else {
    registerInto(handlers)
  }

  return {
    setModelMock,
    commands,
    fetchMock,
    killMock,
    spawnMock,
    spawnedChildren,
    fsMock,
    handlers,
    processEnv: processMock.env,
    callHook,
    emitPiEvent: (name, event) => {
      piEvents.emit(name, event)
    },
    piEventListenerCount: (name) => piEvents.listenerCount(name),
    reload: () => {
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }
      registerInto(handlers)
    },
    replacePiSession: async (reason, targetSessionFile) => {
      await callHook('session_shutdown', { reason, targetSessionFile })
      piEvents = new EventEmitter()
      registerLikePi()
    },
    registerTaskChild: () => {
      const leadHandlerLists = handlerLists
      const childBus = new EventEmitter()
      registerInto({}, childBus)
      handlerLists = leadHandlerLists
      return (name, event) => {
        childBus.emit(name, event)
      }
    },
    reloadPi: async () => {
      await callHook('session_shutdown', { reason: 'reload' })
      register = evaluateModule()
      registerLikePi()
    }
  }
}
