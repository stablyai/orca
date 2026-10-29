import { describe, expect, it, vi } from 'vitest'
import type {
  FilesystemHostOperation,
  FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import type { FilesystemHostProcessHandle } from './filesystem-host-supervisor-scheduling'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function dispatch(path: string) {
  return {
    operationId: path,
    operation: { kind: 'canonicalize-path' as const, path },
    executionHost: 'native' as const,
    storageClass: 'workspace' as const,
    admission: 'foreground' as const,
    deadlineMs: 100
  }
}

function canonical(operation: FilesystemHostOperation): FilesystemHostResult {
  return { kind: 'canonicalize-path', canonicalPath: operation.path }
}

describe('FilesystemHostSupervisor lifecycle', () => {
  it('releases a reservation when process startup rejects before creating a child', async () => {
    const startProcess = vi
      .fn()
      .mockImplementationOnce(async (options) => {
        options.onPhysicalExit?.()
        throw new Error('fork failed')
      })
      .mockResolvedValueOnce({
        invoke: async (operation: FilesystemHostOperation) => canonical(operation),
        retire: async () => true
      })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await expect(supervisor.dispatch(dispatch('/a/repo'))).rejects.toMatchObject({
      code: 'unavailable'
    })
    await expect(supervisor.dispatch(dispatch('/b/repo'))).resolves.toMatchObject({
      canonicalPath: '/b/repo'
    })
    expect(supervisor.health().physicalChildren).toBe(1)
  })

  it('retains a failed startup reservation until its child physically exits', async () => {
    let onPhysicalExit: (() => void) | undefined
    const startProcess = vi.fn(async (options) => {
      onPhysicalExit = options.onPhysicalExit
      throw new Error('ready timeout')
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })

    await expect(supervisor.dispatch(dispatch('/repo'))).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(supervisor.health().physicalChildren).toBe(1)

    onPhysicalExit?.()
    expect(supervisor.health().physicalChildren).toBe(0)
  })

  it('reclaims an idle healthy lane under capacity pressure', async () => {
    const retired: string[] = []
    const startProcess = vi.fn(async (options) => {
      const id = String(startProcess.mock.calls.length)
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation),
        retire: async () => {
          retired.push(id)
          options.onPhysicalExit?.()
          return true
        }
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    for (const domain of ['a', 'b', 'c']) {
      supervisor.publishFailureDomain({
        executionHost: 'native',
        prefix: `/${domain}`,
        mountId: domain
      })
    }

    await supervisor.dispatch(dispatch('/a/repo'))
    await supervisor.dispatch(dispatch('/b/repo'))
    await expect(supervisor.dispatch(dispatch('/c/repo'))).resolves.toMatchObject({
      canonicalPath: '/c/repo'
    })

    expect(startProcess).toHaveBeenCalledTimes(3)
    expect(retired).toHaveLength(1)
    expect(supervisor.health().physicalChildren).toBe(2)
  })

  it('continues reclaiming after an idle child does not exit', async () => {
    const retired: string[] = []
    const startProcess = vi.fn(async (options) => {
      const id = String(startProcess.mock.calls.length)
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation),
        retire: async () => {
          retired.push(id)
          if (id === '1') {
            return false
          }
          options.onPhysicalExit?.()
          return true
        }
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    for (const domain of ['a', 'b', 'c']) {
      supervisor.publishFailureDomain({
        executionHost: 'native',
        prefix: `/${domain}`,
        mountId: domain
      })
    }

    await supervisor.dispatch(dispatch('/a/repo'))
    await supervisor.dispatch(dispatch('/b/repo'))
    await expect(supervisor.dispatch(dispatch('/c/repo'))).resolves.toMatchObject({
      canonicalPath: '/c/repo'
    })

    expect(retired).toEqual(['1', '2'])
    expect(supervisor.health()).toMatchObject({
      physicalChildren: 2,
      didNotExitDomains: 1
    })
  })

  it('retires an in-flight launch before disposal completes', async () => {
    const launch = deferred<FilesystemHostProcessHandle>()
    let onPhysicalExit: (() => void) | undefined
    const startProcess = vi.fn(async (options) => {
      onPhysicalExit = options.onPhysicalExit
      return await launch.promise
    })
    const invoke = vi.fn(async (operation: FilesystemHostOperation) => canonical(operation))
    const retire = vi.fn(async () => {
      onPhysicalExit?.()
      return true
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })

    const pending = supervisor.dispatch(dispatch('/repo'))
    await vi.waitFor(() => expect(startProcess).toHaveBeenCalledOnce())
    const disposal = supervisor.dispose()
    launch.resolve({ invoke, retire })
    await disposal

    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(invoke).not.toHaveBeenCalled()
    expect(retire).toHaveBeenCalledOnce()
    expect(supervisor.health().physicalChildren).toBe(0)
  })
})
