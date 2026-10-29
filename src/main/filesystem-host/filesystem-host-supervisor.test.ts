import { describe, expect, it, vi } from 'vitest'
import type {
  FilesystemHostOperation,
  FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostProcessError } from './filesystem-host-process'
import type { FilesystemHostTelemetryEvent } from './filesystem-host-telemetry'
import type { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

type ProcessHandle = {
  invoke(
    operation: FilesystemHostOperation,
    deadlineMs: number,
    requestId?: string
  ): Promise<FilesystemHostResult>
  retire(): Promise<boolean>
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function canonical(path: string): FilesystemHostResult {
  return { kind: 'canonicalize-path', canonicalPath: path }
}

function dispatch(path: string, operationId: string, admission: 'foreground' | 'background') {
  return {
    operationId,
    operation: { kind: 'canonicalize-path' as const, path },
    executionHost: 'native' as const,
    storageClass: 'workspace' as const,
    admission,
    deadlineMs: 100
  }
}

function classifyDispatch(path: string, operationId: string) {
  return {
    ...dispatch(path, operationId, 'background'),
    operation: { kind: 'classify-path' as const, path }
  }
}

describe('FilesystemHostSupervisor', () => {
  it('serializes one unknown failure-domain lane and reuses its child', async () => {
    const first = deferred<FilesystemHostResult>()
    const invoke = vi
      .fn<ProcessHandle['invoke']>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(canonical('/unknown/b'))
    const retire = vi.fn(async () => true)
    const startProcess = vi.fn(async () => ({ invoke, retire }))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    const firstCall = supervisor.dispatch(dispatch('/unknown/a', 'first', 'foreground'))
    const secondCall = supervisor.dispatch(dispatch('/elsewhere/b', 'second', 'foreground'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    first.resolve(canonical('/unknown/a'))

    await expect(firstCall).resolves.toEqual(canonical('/unknown/a'))
    await expect(secondCall).resolves.toEqual(canonical('/unknown/b'))
    expect(startProcess).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('admits queued foreground work before older background work', async () => {
    const first = deferred<FilesystemHostResult>()
    const order: string[] = []
    const invoke = vi.fn(
      async (operation: FilesystemHostOperation, _deadlineMs: number, requestId?: string) => {
        order.push(requestId ?? '')
        if (requestId === 'running-background') {
          return first.promise
        }
        return canonical(operation.path)
      }
    )
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess: async () => ({ invoke, retire: async () => true })
    })

    const running = supervisor.dispatch(
      dispatch('/unknown/running', 'running-background', 'background')
    )
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const background = supervisor.dispatch(
      dispatch('/unknown/background', 'queued-background', 'background')
    )
    const foreground = supervisor.dispatch(
      dispatch('/unknown/foreground', 'queued-foreground', 'foreground')
    )
    first.resolve(canonical('/unknown/running'))

    await Promise.all([running, background, foreground])
    expect(order).toEqual(['running-background', 'queued-foreground', 'queued-background'])
  })

  it('runs verified independent mounts concurrently', async () => {
    const invocations: ReturnType<typeof deferred<FilesystemHostResult>>[] = []
    const startProcess = vi.fn(async () => {
      const next = deferred<FilesystemHostResult>()
      invocations.push(next)
      return { invoke: () => next.promise, retire: async () => true }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    const a = supervisor.dispatch(dispatch('/a/repo', 'a', 'foreground'))
    const b = supervisor.dispatch(dispatch('/b/repo', 'b', 'foreground'))
    await vi.waitFor(() => expect(invocations).toHaveLength(2))
    invocations[0].resolve(canonical('/a/repo'))
    invocations[1].resolve(canonical('/b/repo'))

    await expect(Promise.all([a, b])).resolves.toHaveLength(2)
  })

  it('isolates unclassified path probes before their mount is known', async () => {
    const stalled = deferred<FilesystemHostResult>()
    const startProcess = vi.fn(async () => ({
      invoke: async (operation: FilesystemHostOperation) =>
        operation.path === '/stalled'
          ? stalled.promise
          : ({ kind: 'classify-path', deviceId: 'healthy-device' } as const),
      retire: async () => true
    }))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      startProcess
    })

    const stalledProbe = supervisor.dispatch(classifyDispatch('/stalled', 'stalled'))
    await expect(supervisor.dispatch(classifyDispatch('/healthy', 'healthy'))).resolves.toEqual({
      kind: 'classify-path',
      deviceId: 'healthy-device'
    })
    expect(startProcess).toHaveBeenCalledTimes(2)

    stalled.resolve({ kind: 'classify-path', deviceId: 'stalled-device' })
    await expect(stalledProbe).resolves.toEqual({
      kind: 'classify-path',
      deviceId: 'stalled-device'
    })
  })

  it('retires successful classification lanes instead of retaining path-shaped state', async () => {
    const retire = vi.fn(async () => true)
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      startProcess: async () => ({
        invoke: async () => ({ kind: 'classify-path', deviceId: 'device-a' }),
        retire
      })
    })

    await supervisor.dispatch(classifyDispatch('/repo', 'classify'))

    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(supervisor.health().physicalChildren).toBe(0))
    expect(supervisor.health().breakers).toEqual({})
  })

  it('retires an idle mount lane after its final catalog prefix is removed', async () => {
    const retire = vi.fn(async () => true)
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      startProcess: async () => ({
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire
      })
    })
    supervisor.publishFailureDomain({
      executionHost: 'native',
      prefix: '/repo',
      mountId: 'device-a'
    })
    await supervisor.dispatch(dispatch('/repo', 'read', 'foreground'))

    supervisor.removeFailureDomain({ executionHost: 'native', prefix: '/repo' })

    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(supervisor.health().physicalChildren).toBe(0))
    expect(supervisor.health().breakers).toEqual({})
  })

  it('keeps the final physical slot available to foreground work', async () => {
    const exits: (() => void)[] = []
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => {
      exits.push(() => options.onPhysicalExit?.())
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire: async () => true
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await supervisor.dispatch(dispatch('/a/repo', 'a', 'background'))
    await expect(
      supervisor.dispatch(dispatch('/b/repo', 'b-bg', 'background'))
    ).rejects.toMatchObject({ code: 'capacity' })
    await expect(supervisor.dispatch(dispatch('/b/repo', 'b-fg', 'foreground'))).resolves.toEqual(
      canonical('/b/repo')
    )
    expect(supervisor.health().physicalChildren).toBe(2)
    exits.forEach((exit) => exit())
  })

  it('opens the breaker, bounds abandonment, and permits one delayed canary', async () => {
    let now = 100
    let launches = 0
    const exits: (() => void)[] = []
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => {
      launches++
      exits.push(() => options.onPhysicalExit?.())
      if (launches === 1) {
        return {
          invoke: async () => {
            throw new FilesystemHostProcessError('deadline', 'timed out')
          },
          retire: async () => false
        }
      }
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire: async () => true
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      breakerRecoveryDelayMs: 1_000,
      now: () => now,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'timeout', 'foreground'))
    ).rejects.toMatchObject({ code: 'deadline' })
    await vi.waitFor(() => expect(supervisor.health().abandonedChildren).toBe(1))
    expect(supervisor.health()).toMatchObject({
      physicalChildren: 1,
      didNotExitDomains: 1,
      breakers: { 'native:a': 'open' }
    })
    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'open', 'foreground'))
    ).rejects.toMatchObject({ code: 'breaker-open' })

    now = 1_100
    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'blocked-canary', 'foreground'))
    ).rejects.toMatchObject({ code: 'unreaped' })
    exits[0]()
    now = 2_200
    await expect(supervisor.dispatch(dispatch('/a/repo', 'canary', 'foreground'))).resolves.toEqual(
      canonical('/a/repo')
    )
    expect(supervisor.health().breakers['native:a']).toBe('closed')
    expect(supervisor.health().physicalChildren).toBe(1)
    exits.forEach((exit) => exit())
  })

  it('refuses to re-fork a domain holding an unreaped child until it physically exits', async () => {
    let now = 100
    let launches = 0
    const exits: (() => void)[] = []
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => {
      launches++
      exits.push(() => options.onPhysicalExit?.())
      if (launches === 1) {
        return {
          invoke: async () => {
            throw new FilesystemHostProcessError('deadline', 'timed out')
          },
          // A child wedged in an uninterruptible syscall ignores SIGKILL.
          retire: async () => false
        }
      }
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire: async () => true
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      breakerRecoveryDelayMs: 1_000,
      now: () => now,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'timeout', 'foreground'))
    ).rejects.toMatchObject({ code: 'deadline' })
    await vi.waitFor(() => expect(supervisor.health().didNotExitDomains).toBe(1))

    // Each breaker probe would otherwise fork another child that also never exits.
    for (const probeAt of [1_100, 2_200, 3_300]) {
      now = probeAt
      await expect(
        supervisor.dispatch(dispatch('/a/repo', `probe-${probeAt}`, 'foreground'))
      ).rejects.toMatchObject({ code: 'unreaped' })
    }
    expect(startProcess).toHaveBeenCalledTimes(1)
    expect(supervisor.health().physicalChildren).toBe(1)

    // A healthy mount keeps its share of the budget.
    await expect(
      supervisor.dispatch(dispatch('/b/repo', 'healthy', 'foreground'))
    ).resolves.toEqual(canonical('/b/repo'))

    exits[0]()
    now = 10_000
    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'recovered', 'foreground'))
    ).resolves.toEqual(canonical('/a/repo'))
    expect(supervisor.health().didNotExitDomains).toBe(0)
  })

  it('keeps domain errors on the healthy child and emits path-free telemetry', async () => {
    const events: FilesystemHostTelemetryEvent[] = []
    const invoke = vi
      .fn<ProcessHandle['invoke']>()
      .mockRejectedValueOnce(new FilesystemHostProcessError('operation', 'missing', 'missing'))
      .mockResolvedValueOnce(canonical('/secret/repo'))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess: async () => ({ invoke, retire: async () => true }),
      onTelemetry: (event) => events.push(event)
    })

    await expect(
      supervisor.dispatch(dispatch('/secret/repo', 'domain-error', 'foreground'))
    ).rejects.toEqual(
      expect.objectContaining<Partial<FilesystemHostSupervisorError>>({
        code: 'operation',
        operationCode: 'missing'
      })
    )
    await expect(
      supervisor.dispatch(dispatch('/secret/repo', 'success', 'foreground'))
    ).resolves.toEqual(canonical('/secret/repo'))

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(events)).not.toContain('/secret/repo')
    expect(events.map((event) => event.result)).toEqual(['domain-error', 'success'])
  })

  it('rejects SSH and misrouted WSL work before allocating a child', async () => {
    const startProcess = vi.fn()
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    await expect(
      supervisor.dispatch({
        ...dispatch('/remote/repo', 'ssh', 'foreground'),
        executionHost: 'ssh' as never
      })
    ).rejects.toMatchObject({ code: 'remote-host' })
    await expect(
      supervisor.dispatch({
        ...dispatch('/mnt/c/repo', 'wsl', 'foreground'),
        storageClass: 'wsl'
      })
    ).rejects.toMatchObject({ code: 'remote-host' })
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('schema-validates operations in main before allocating a child', async () => {
    const startProcess = vi.fn()
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    await expect(
      supervisor.dispatch({
        ...dispatch('/repo', 'invalid', 'foreground'),
        operation: { kind: 'read-file', path: '/repo/secret' } as never
      })
    ).rejects.toMatchObject({ code: 'operation' })
    expect(startProcess).not.toHaveBeenCalled()
  })
})
