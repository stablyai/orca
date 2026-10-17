import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import { vi } from 'vitest'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

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

export function createHarness(
  options: {
    paneKey?: string
    platform?: NodeJS.Platform
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

  const module: {
    exports: {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        getSessionName: () => string
      }) => void
    }
  } = { exports: {} }

  const context: Record<string, unknown> = {
    module,
    exports: module.exports,
    process: {
      env: { ORCA_PANE_KEY: options.paneKey ?? 'pane-1', ...options.env },
      pid: options.env?.ORCA_PI_TITLE_MARKER_OWNED === undefined ? 111 : 222,
      title: options.processTitle ?? 'pi',
      platform: options.platform ?? 'darwin',
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
  }
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
