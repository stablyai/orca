import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { vi } from 'vitest'

import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

export type HookContext = {
  isIdle?: () => boolean
  sessionManager?: {
    getSessionId?: () => unknown
    getSessionFile?: () => unknown
  }
}

export type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

type FakeCurlChild = {
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

export type AgentStatusExtensionHarness = {
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
  // Re-invoke the extension factory in the same process (as Pi does on an
  // in-process extension reload), swapping in the freshly registered handlers.
  reload: () => void
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
  env?: Record<string, string | undefined>
  pid?: number
  title?: string
  argv?: readonly string[]
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: string) => string
  statSync?: (path: string) => { mtimeMs: number; size: number; ino: number }
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
}): AgentStatusExtensionHarness {
  const fetchMock = vi.fn(
    args.fetchImpl ??
      (async () => ({
        ok: true
      }))
  )

  const spawnedChildren: FakeCurlChild[] = []
  const spawnMock = vi.fn(() => {
    const child: FakeCurlChild = {
      on: vi.fn(),
      stdin: {
        on: vi.fn(),
        end: vi.fn()
      }
    }
    spawnedChildren.push(child)
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

  const module = {
    exports: {} as { default?: (pi: { on: (name: string, handler: HookHandler) => void }) => void }
  }
  const requireMock = vi.fn((specifier: string) => {
    if (specifier === 'fs') {
      return fsMock
    }
    if (specifier === 'child_process') {
      return { spawn: spawnMock }
    }
    throw new Error(`unexpected require(${specifier})`)
  })

  const processMock = {
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
  runInNewContext(output, context)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  const registerInto = (target: Record<string, HookHandler>): void => {
    register({
      on(name: string, handler: HookHandler) {
        target[name] = handler
      }
    })
  }
  registerInto(handlers)

  return {
    fetchMock,
    spawnMock,
    spawnedChildren,
    fsMock,
    handlers,
    processEnv: processMock.env,
    callHook: async (name, event, hookContext) => {
      await handlers[name]?.(event, hookContext)
    },
    reload: () => {
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }
      registerInto(handlers)
    }
  }
}
