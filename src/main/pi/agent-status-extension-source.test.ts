import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it, vi } from 'vitest'

import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

type HookHandler = (event?: unknown) => Promise<void> | void

type FakeCurlChild = {
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

type Harness = {
  fetchMock: ReturnType<typeof vi.fn>
  spawnMock: ReturnType<typeof vi.fn>
  spawnedChildren: FakeCurlChild[]
  fsMock: {
    existsSync: ReturnType<typeof vi.fn>
    readFileSync: ReturnType<typeof vi.fn>
  }
  handlers: Record<string, HookHandler>
  callHook: (name: string, event?: unknown) => Promise<void>
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

function createHarness(args: {
  kind: 'pi' | 'omp'
  env?: Record<string, string | undefined>
  title?: string
  argv?: string[]
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: string) => string
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
}): Harness {
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
      ...args.env
    },
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
  register({
    on(name: string, handler: HookHandler) {
      handlers[name] = handler
    }
  })

  return {
    fetchMock,
    spawnMock,
    spawnedChildren,
    fsMock,
    handlers,
    callHook: async (name, event) => {
      await handlers[name]?.(event)
    }
  }
}

describe('getPiAgentStatusExtensionSource', () => {
  it('routes an OMP executable through /hook/omp', async () => {
    const harness = createHarness({
      kind: 'pi',
      title: 'omp',
      existsSync: () => false
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/omp')
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('keeps native fetch as the only path even when the runtime looks like WSL', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: () => true
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('falls back to Windows curl from WSL when fetch fails', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(harness.spawnMock).toHaveBeenCalledTimes(1))

    const [command, args, options] = harness.spawnMock.mock.calls[0] ?? []
    expect(command).toBe('/mnt/c/Windows/System32/curl.exe')
    expect(args).toEqual([
      '-sS',
      '--connect-timeout',
      '3',
      '--max-time',
      '10',
      '--noproxy',
      '127.0.0.1',
      '-o',
      'NUL',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-H',
      'X-Orca-Agent-Hook-Token: token-1',
      '--data-binary',
      '@-',
      'http://127.0.0.1:4321/hook/omp'
    ])
    // Why: delivery must be fire-and-forget off the pi event loop — no
    // blocking wait — with the payload fed via stdin, never argv.
    expect(options).toEqual({ stdio: ['pipe', 'ignore', 'ignore'] })
    const child = harness.spawnedChildren[0]
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child?.stdin.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child?.stdin.end).toHaveBeenCalledWith(
      JSON.stringify({
        paneKey: 'pane-1',
        launchToken: 'launch-1',
        tabId: 'tab-1',
        worktreeId: 'tree-1',
        env: 'env-1',
        version: '1.2.3',
        payload: { hook_event_name: 'agent_start' }
      })
    )
  })

  it('probes WSL evidence and the curl path once per process', async () => {
    const harness = createHarness({
      kind: 'omp',
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      readFileSync: (path) => {
        if (path === '/proc/sys/kernel/osrelease') {
          return 'microsoft-standard-WSL2'
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.spawnMock).toHaveBeenCalledTimes(2))
    // Why: WSL-ness and curl.exe presence are process-lifetime constants;
    // the per-event failure path must not re-probe /proc or /mnt/c.
    const procReads = harness.fsMock.readFileSync.mock.calls.filter(([path]) =>
      String(path).startsWith('/proc/')
    )
    expect(procReads).toHaveLength(1)
    expect(harness.fsMock.existsSync).toHaveBeenCalledTimes(1)
  })

  it('stays fail-open on ordinary Linux', async () => {
    const harness = createHarness({
      kind: 'omp',
      existsSync: () => true,
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('does not hold Pi event dispatch open while hook delivery is pending', async () => {
    let finishDelivery: (() => void) | undefined
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(
        () =>
          new Promise((resolve) => {
            finishDelivery = () => resolve({ ok: true })
          })
      )
    })

    let handlerReturned = false
    const handlerCall = harness.callHook('agent_start').then(() => {
      handlerReturned = true
    })
    await Promise.resolve()

    // Why: Pi awaits extension handlers, so loopback status delivery cannot
    // remain on the agent's critical path when Orca is stalled or restarting.
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(handlerReturned).toBe(true))

    finishDelivery?.()
    await handlerCall
  })

  it('leaves runtime shutdown to PTY teardown instead of reporting turn completion', () => {
    const harness = createHarness({ kind: 'pi' })

    // Why: Pi emits session_shutdown for reload/new/resume/fork while its PTY
    // stays alive. agent_end is the only extension event that proves done.
    expect(harness.handlers.session_shutdown).toBeUndefined()
  })

  it('bounds stalled delivery to one active request and the latest pending status', async () => {
    const finishDeliveries: (() => void)[] = []
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(
        () =>
          new Promise((resolve) => {
            finishDeliveries.push(() => resolve({ ok: true }))
          })
      )
    })

    await Promise.all([
      harness.callHook('agent_start'),
      harness.callHook('tool_execution_start', { toolName: 'read', args: { path: 'one.ts' } }),
      harness.callHook('agent_end')
    ])

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    finishDeliveries[0]?.()
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    const latestBody = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
    expect(latestBody.payload).toEqual({ hook_event_name: 'agent_end' })

    finishDeliveries[1]?.()
  })

  it('abandons a stalled request after one second and delivers the latest status', async () => {
    vi.useFakeTimers()
    try {
      let requestCount = 0
      const harness = createHarness({
        kind: 'pi',
        fetchImpl: vi.fn(() => {
          requestCount += 1
          return requestCount === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true })
        })
      })

      await harness.callHook('agent_start')
      await harness.callHook('agent_end')

      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      const firstSignal = harness.fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)

      expect(firstSignal.aborted).toBe(true)
      expect(harness.fetchMock).toHaveBeenCalledTimes(2)
      const latestBody = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
      expect(latestBody.payload).toEqual({ hook_event_name: 'agent_end' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat WSLENV alone as WSL evidence', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSLENV: 'FOO/u' },
      existsSync: () => true,
      readFileSync: (path) => {
        if (path === '/proc/sys/kernel/osrelease' || path === '/proc/version') {
          return 'Linux 6.8.0 generic'
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('remains fail-open when the Windows curl bridge is missing', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: () => false,
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await expect(harness.callHook('agent_start')).resolves.toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })
})
