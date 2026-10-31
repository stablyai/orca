import './rpc/unused-default-rpc-methods.test-fixture'
import { existsSync, mkdtempSync } from 'node:fs'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'
import { createRuntimeTransportMetadata } from './runtime-rpc/runtime-rpc-socket-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { DeviceRegistry } from './device-registry'
import * as hostDescriptorModule from './host-descriptor'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'

vi.mock('node:net', async (importOriginal) => {
  return { ...(await importOriginal<typeof net>()) }
})

vi.mock('node:http', async (importOriginal) => {
  return { ...(await importOriginal<typeof http>()) }
})

vi.mock('node:fs', async (importOriginal) => {
  return { ...(await importOriginal<typeof fs>()) }
})

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

type RpcNativeObservation = {
  server: net.Server
  listened: boolean
  closed: boolean
  completion: Promise<void>
}

function observeRpcNativeServer(server: net.Server): RpcNativeObservation {
  const observation: RpcNativeObservation = {
    server,
    listened: false,
    closed: false,
    completion: new Promise<void>((resolve) => {
      server.once('close', () => {
        observation.closed = true
        resolve()
      })
    })
  }
  server.once('listening', () => {
    observation.listened = true
  })
  return observation
}

// Only the RED negative control needs this exact native owner after production loses it.
async function emergencyCloseRpcNativeServer(observation: RpcNativeObservation): Promise<void> {
  if (!observation.listened || observation.closed) {
    return
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('RPC native close receipt timed out')), 5_000)
  })
  const closing = new Promise<void>((resolve, reject) => {
    observation.server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  try {
    await Promise.race([Promise.all([closing, observation.completion]), deadline])
  } finally {
    clearTimeout(timeout)
  }
}

describe('OrcaRuntimeRpcServer', () => {
  it('writes runtime metadata with transport details when started', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    expect(metadata?.runtimeId).toBe(runtime.getRuntimeId())
    expect(metadata?.authToken).toBeTruthy()
    expect(metadata?.transports?.[0]?.endpoint).toBeTruthy()
    expect(metadata?.transports).toEqual(server['transports'])

    await server.stop()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      runtimeId: runtime.getRuntimeId()
    })
  })

  it('reclaims runtime metadata clobbered by a second instance that has since died', async () => {
    // A second instance can replace metadata then exit; reclaim it so CLI finds this still-serving runtime (#7848).
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })
    await server.start()
    const published = readRuntimeMetadata(userDataPath)

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [{ kind: 'unix', endpoint: join(userDataPath, 'o-99999999-rt2.sock') }],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    await server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toEqual(published)

    await server.stop()
  })

  it('leaves runtime metadata owned by a live sibling runtime untouched', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Use a synthetic owned pid and process.pid as live sibling; Windows never assigns pid 1.
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      pid: 4242
    })
    await server.start()

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_live_sibling',
      pid: process.pid,
      transports: [{ kind: 'unix', endpoint: join(userDataPath, `o-${process.pid}-rt2.sock`) }],
      authToken: 'sibling-token',
      startedAt: 1
    })
    await server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_live_sibling' })

    await server.stop()
  })

  it('stops reclaiming runtime metadata after the server is stopped', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath
    })
    await server.start()
    const watch = server['metadataOwnershipWatch']
    if (!watch) {
      throw new Error('start() must arm the metadata ownership watch')
    }
    // Assert timer cancellation too; republish guard alone masks leaked intervals.
    const watchStop = vi.spyOn(watch, 'stop')
    await server.stop()

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    await server.checkRuntimeMetadataOwnership()

    expect(watchStop).toHaveBeenCalledTimes(1)
    expect(server['metadataOwnershipWatch']).toBeNull()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_second_instance' })
  })

  it('drops a republish from an ownership read that lands after the server stopped', async () => {
    // In-flight async reads can outlive stop; activeTransports must prevent late republish.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath, pid: 1001 })
    await server.start()

    let releaseRead: (record: RuntimeMetadata | null) => void = () => {}
    vi.spyOn(runtimeMetadataModule, 'readRuntimeMetadataAsync').mockImplementationOnce(
      () =>
        new Promise<RuntimeMetadata | null>((resolve) => {
          releaseRead = resolve
        })
    )
    const heldCheck = server.checkRuntimeMetadataOwnership()

    await server.stop()
    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    // A missing record is the most reclaimable verdict there is, so an unguarded
    // resume would rewrite the file the second instance just published.
    releaseRead(null)
    await heldCheck

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_second_instance' })
  })

  it('flushes a lastSeen refresh scheduled while transports stop', async () => {
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
      enableWebSocket: false
    })
    let pending = false
    const timeline: string[] = []
    server['deviceRegistry'] = {
      flushPendingLastSeen: vi.fn(() => {
        timeline.push(pending ? 'flush-pending' : 'flush-empty')
        pending = false
      })
    } as unknown as DeviceRegistry
    let finishSecondStop: () => void = () => {}
    const secondStop = new Promise<void>((resolve) => {
      finishSecondStop = resolve
    })
    server['activeTransports'] = [
      {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          timeline.push('failed-transport-stop')
          throw new Error('transport stop failed')
        })
      },
      {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          timeline.push('second-transport-started')
          await secondStop
          timeline.push('second-transport-stopped')
          pending = true
        })
      }
    ]

    const stopping = server.stop()
    await vi.waitFor(() => expect(timeline).toContain('second-transport-started'))
    expect(timeline).not.toContain('flush-empty')
    finishSecondStop()
    await expect(stopping).rejects.toThrow('transport stop failed')

    expect(timeline).toEqual([
      'failed-transport-stop',
      'second-transport-started',
      'second-transport-stopped',
      'flush-pending'
    ])
    expect(pending).toBe(false)
  })

  it('leaves the last published metadata in place when a runtime stops', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime,
      userDataPath,
      pid: 1001
    })

    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    expect(metadata?.pid).toBe(1001)

    await server.stop()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      pid: 1001,
      runtimeId: runtime.getRuntimeId()
    })
  })

  it('closes the socket if metadata publication fails during startup', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })
    const writeMetadataSpy = vi
      .spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
      .mockImplementationOnce(() => {
        throw new Error('write failed')
      })
    const endpoint = createRuntimeTransportMetadata(
      userDataPath,
      process.pid,
      process.platform,
      runtime.getRuntimeId()
    ).endpoint

    await expect(server.start()).rejects.toThrow('write failed')
    expect(readRuntimeMetadata(userDataPath)).toBeNull()
    expect(existsSync(endpoint)).toBe(false)
    expect(server['transports']).toEqual([])
    expect(server['activeTransports']).toEqual([])

    writeMetadataSpy.mockRestore()
  })

  it.skipIf(process.platform === 'win32')(
    'retires the actual native listener after post-listen chmod EIO',
    async () => {
      const runtime = new OrcaRuntimeService()
      const userDataPath = mkdtempSync(join('/tmp', 'o-rpc-'))
      let server: OrcaRuntimeRpcServer | undefined
      const endpoint = createRuntimeTransportMetadata(
        userDataPath,
        process.pid,
        process.platform,
        runtime.getRuntimeId()
      ).endpoint
      const initiating = Object.assign(new Error('socket chmod failed'), { code: 'EIO' })
      const native: RpcNativeObservation[] = []
      const restores: (() => void)[] = []
      const operations: Promise<unknown>[] = []
      const errors: unknown[] = []
      try {
        const rpc = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })
        server = rpc
        expect(Buffer.byteLength(endpoint, 'utf8')).toBeLessThan(104)
        const create = net.createServer
        const createSpy = vi.spyOn(net, 'createServer').mockImplementation((...args) => {
          const acquired = create(...args)
          native.push(observeRpcNativeServer(acquired))
          return acquired
        })
        restores.push(() => createSpy.mockRestore())
        const chmod = fs.chmodSync
        const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
          if (path === endpoint) {
            throw initiating
          }
          return chmod(path, mode)
        })
        restores.push(() => chmodSpy.mockRestore())
        const started = Promise.allSettled([rpc.start()])
        operations.push(started)
        const [result] = await started
        expect(result?.status).toBe('rejected')
        if (result?.status !== 'rejected') {
          throw new Error('chmod failure unexpectedly started RPC')
        }
        expect(result.reason).toBe(initiating)
        expect(chmodSpy).toHaveBeenCalledWith(endpoint, 0o600)
        expect(native).toHaveLength(1)
        expect(native[0]?.listened).toBe(true)
        expect(native[0]?.closed).toBe(true)
        expect(readRuntimeMetadata(userDataPath)).toBeNull()
        await rpc.stop()
        expect(native[0]?.closed).toBe(true)
        expect(existsSync(endpoint)).toBe(false)
      } catch (error) {
        errors.push(error)
      }
      for (const restore of restores) {
        try {
          restore()
        } catch (error) {
          errors.push(error)
        }
      }
      await Promise.allSettled(operations)
      let stopped = false
      try {
        await server?.stop()
        stopped = true
      } catch (error) {
        errors.push(error)
      }
      for (const observation of native) {
        try {
          await emergencyCloseRpcNativeServer(observation)
        } catch (error) {
          errors.push(error)
        }
      }
      if (stopped && native.every((observation) => !observation.listened || observation.closed)) {
        try {
          fs.rmSync(userDataPath, { recursive: true, force: true })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'RPC chmod regression and cleanup failed', {
          cause: errors[0]
        })
      }
    }
  )

  it('joins two public stops through held real initialization without publishing after stop', async () => {
    const userDataPath = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/tmp', 'o-rpc-')
    )
    let server: OrcaRuntimeRpcServer | undefined
    const native: RpcNativeObservation[] = []
    const restores: (() => void)[] = []
    const errors: unknown[] = []
    let releaseDescriptor = (): void => {}
    const heldDescriptor = new Promise<void>((resolve) => {
      releaseDescriptor = resolve
    })
    let started: Promise<PromiseSettledResult<void>[]> | undefined
    let stopping: Promise<PromiseSettledResult<void>[]> | undefined
    let completedStops = 0
    let latePublications = 0
    try {
      const rpc = new OrcaRuntimeRpcServer({
        methods: [],
        runtime: new OrcaRuntimeService(),
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      server = rpc
      const create = net.createServer
      const createSpy = vi.spyOn(net, 'createServer').mockImplementation((...args) => {
        const acquired = create(...args)
        native.push(observeRpcNativeServer(acquired))
        return acquired
      })
      restores.push(() => createSpy.mockRestore())
      const createHttp = http.createServer
      const httpSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
        const acquired = createHttp(...args)
        native.push(observeRpcNativeServer(acquired))
        return acquired
      })
      restores.push(() => httpSpy.mockRestore())
      const load = hostDescriptorModule.loadHostDescriptor
      const descriptorSpy = vi
        .spyOn(hostDescriptorModule, 'loadHostDescriptor')
        .mockImplementation(async (...args) => {
          await heldDescriptor
          return load(...args)
        })
      restores.push(() => descriptorSpy.mockRestore())
      const write = runtimeMetadataModule.writeRuntimeMetadata
      const writeSpy = vi
        .spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
        .mockImplementation((...args) => {
          if (completedStops > 0) {
            latePublications += 1
          }
          return write(...args)
        })
      restores.push(() => writeSpy.mockRestore())
      started = Promise.allSettled([rpc.start()])
      await vi.waitFor(() => expect(descriptorSpy).toHaveBeenCalledOnce())
      expect(native).toHaveLength(1)
      expect(native[0]?.listened).toBe(true)
      const stops = [rpc.stop(), rpc.stop()]
      stopping = Promise.allSettled(stops)
      for (const stop of stops) {
        void stop.then(
          () => {
            completedStops += 1
          },
          () => {
            completedStops += 1
          }
        )
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(completedStops).toBe(0)
    } catch (error) {
      errors.push(error)
    }
    releaseDescriptor()
    if (started) {
      const results = await started
      try {
        expect(results).toEqual([{ status: 'fulfilled', value: undefined }])
      } catch (error) {
        errors.push(error)
      }
    }
    if (stopping) {
      const results = await stopping
      try {
        expect(results).toEqual([
          { status: 'fulfilled', value: undefined },
          { status: 'fulfilled', value: undefined }
        ])
      } catch (error) {
        errors.push(error)
      }
      try {
        expect(completedStops).toBe(2)
        expect(latePublications).toBe(0)
        expect(native).toHaveLength(2)
        expect(native.every((observation) => observation.listened && observation.closed)).toBe(true)
        await server?.checkRuntimeMetadataOwnership()
        expect(latePublications).toBe(0)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const restore of restores) {
      try {
        restore()
      } catch (error) {
        errors.push(error)
      }
    }
    let stopped = false
    try {
      await server?.stop()
      stopped = true
    } catch (error) {
      errors.push(error)
    }
    for (const observation of native) {
      try {
        await emergencyCloseRpcNativeServer(observation)
      } catch (error) {
        errors.push(error)
      }
    }
    if (stopped && native.every((observation) => !observation.listened || observation.closed)) {
      try {
        fs.rmSync(userDataPath, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) {
      throw errors[0]
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'RPC pending initialization and cleanup failed', {
        cause: errors[0]
      })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'retains metadata failure and injected post-close unlink debt while joining independent cleanup',
    async () => {
      const runtime = new OrcaRuntimeService()
      const userDataPath = mkdtempSync(join('/tmp', 'o-rpc-'))
      let server: OrcaRuntimeRpcServer | undefined
      const endpoint = createRuntimeTransportMetadata(
        userDataPath,
        process.pid,
        process.platform,
        runtime.getRuntimeId()
      ).endpoint
      const initiating = Object.assign(new Error('metadata publication failed'), { code: 'EIO' })
      const unlinkFailure = Object.assign(new Error('injected post-close unlink failed'), {
        code: 'EIO'
      })
      const native: RpcNativeObservation[] = []
      const restores: (() => void)[] = []
      const errors: unknown[] = []
      const timeline: string[] = []
      let releaseHttpClose = (): void => {}
      const heldHttpClose = new Promise<void>((resolve) => {
        releaseHttpClose = resolve
      })
      let rejectUnlink = true
      let injectResidue = true
      let unlinkAttempts = 0
      let httpCloseArrived = false
      let completedStops = 0
      let started: Promise<PromiseSettledResult<void>[]> | undefined
      let stopping: Promise<PromiseSettledResult<void>[]> | undefined
      try {
        const rpc = new OrcaRuntimeRpcServer({
          methods: [],
          runtime,
          userDataPath,
          enableWebSocket: true,
          wsPort: 0
        })
        server = rpc
        expect(Buffer.byteLength(endpoint, 'utf8')).toBeLessThan(104)
        const create = net.createServer
        const createSpy = vi.spyOn(net, 'createServer').mockImplementation((...args) => {
          const acquired = create(...args)
          const observation = observeRpcNativeServer(acquired)
          native.push(observation)
          acquired.once('close', () => {
            if (injectResidue && observation.listened) {
              try {
                // Node already closed/unlinked S; this is deliberately injected filesystem debt.
                fs.writeFileSync(endpoint, 'injected post-close residue')
                timeline.push('unix-native-closed')
              } catch (error) {
                errors.push(error)
              }
            }
          })
          return acquired
        })
        restores.push(() => createSpy.mockRestore())
        const createHttp = http.createServer
        const httpSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
          const acquired = createHttp(...args)
          native.push(observeRpcNativeServer(acquired))
          const close = acquired.close
          const closeSpy = vi.spyOn(acquired, 'close').mockImplementation(function (
            this: http.Server,
            callback
          ) {
            return close.call(this, (error) => {
              httpCloseArrived = true
              timeline.push('http-native-closed')
              void heldHttpClose.then(() => {
                timeline.push('http-close-delivered')
                callback?.call(this, error)
              })
            })
          })
          restores.push(() => closeSpy.mockRestore())
          return acquired
        })
        restores.push(() => httpSpy.mockRestore())
        const rm = fs.rmSync
        const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
          if (path === endpoint) {
            unlinkAttempts += 1
            if (rejectUnlink) {
              throw unlinkFailure
            }
          }
          return rm(path, options)
        })
        restores.push(() => rmSpy.mockRestore())
        const write = runtimeMetadataModule.writeRuntimeMetadata
        const writeSpy = vi
          .spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
          .mockImplementation((...args) => {
            if (args[0] !== userDataPath) {
              return write(...args)
            }
            const registry = rpc['deviceRegistry']
            if (!registry) {
              throw new Error('real pairing registry was not initialized')
            }
            const flush = registry.flushPendingLastSeen
            const flushSpy = vi.spyOn(registry, 'flushPendingLastSeen').mockImplementation(() => {
              timeline.push('lastSeen-flush')
              return flush.call(registry)
            })
            restores.push(() => flushSpy.mockRestore())
            throw initiating
          })
        restores.push(() => writeSpy.mockRestore())
        started = Promise.allSettled([rpc.start()])
        await vi.waitFor(() => {
          expect(unlinkAttempts).toBe(1)
          expect(httpCloseArrived).toBe(true)
        })
        const stops = [rpc.stop(), rpc.stop()]
        stopping = Promise.allSettled(stops)
        for (const stop of stops) {
          void stop.then(
            () => {
              completedStops += 1
            },
            () => {
              completedStops += 1
            }
          )
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(completedStops).toBe(0)
        expect(timeline).not.toContain('lastSeen-flush')
        expect(native).toHaveLength(2)
        expect(native.every((observation) => observation.listened && observation.closed)).toBe(true)
      } catch (error) {
        errors.push(error)
      }
      releaseHttpClose()
      if (started) {
        const [result] = await started
        try {
          expect(result?.status).toBe('rejected')
          if (result?.status !== 'rejected') {
            throw new Error('metadata failure unexpectedly started RPC')
          }
          expect(result.reason).toBeInstanceOf(AggregateError)
          if (!(result.reason instanceof AggregateError)) {
            throw new Error('metadata cleanup failure was not aggregated')
          }
          expect(result.reason.message).toBe(initiating.message)
          expect(result.reason.cause).toBe(initiating)
          expect(result.reason.errors).toEqual([initiating, unlinkFailure])
        } catch (error) {
          errors.push(error)
        }
      }
      if (stopping) {
        const results = await stopping
        for (const result of results) {
          try {
            expect(result.status).toBe('rejected')
            if (result.status !== 'rejected') {
              throw new Error('stop lost pending rollback cleanup failure')
            }
            const failures =
              result.reason instanceof AggregateError ? result.reason.errors : [result.reason]
            expect(failures).toContain(unlinkFailure)
          } catch (error) {
            errors.push(error)
          }
        }
        try {
          expect(timeline.indexOf('lastSeen-flush')).toBeGreaterThan(
            timeline.indexOf('http-close-delivered')
          )
          expect(readRuntimeMetadata(userDataPath)).toBeNull()
          expect(server?.['transports']).toEqual([])
          expect(existsSync(endpoint)).toBe(true)
        } catch (error) {
          errors.push(error)
        }
      }
      rejectUnlink = false
      injectResidue = false
      try {
        await server?.stop()
        if (stopping) {
          expect(unlinkAttempts).toBe(2)
          expect(existsSync(endpoint)).toBe(false)
          expect(native.every((observation) => observation.listened && observation.closed)).toBe(
            true
          )
        }
      } catch (error) {
        errors.push(error)
      }
      for (const restore of restores) {
        try {
          restore()
        } catch (error) {
          errors.push(error)
        }
      }
      let stopped = false
      try {
        await server?.stop()
        stopped = true
      } catch (error) {
        errors.push(error)
      }
      for (const observation of native) {
        try {
          await emergencyCloseRpcNativeServer(observation)
        } catch (error) {
          errors.push(error)
        }
      }
      if (stopped && native.every((observation) => !observation.listened || observation.closed)) {
        try {
          fs.rmSync(userDataPath, { recursive: true, force: true })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'RPC metadata debt regression and cleanup failed', {
          cause: errors[0]
        })
      }
    }
  )
})
