import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'
import { createRuntimeTransportMetadata, OrcaRuntimeRpcServer } from './runtime-rpc'
import type { DeviceRegistry } from './device-registry'

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

describe('OrcaRuntimeRpcServer', () => {
  it('writes runtime metadata with transport details when started', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

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
    // Why: #7848 — a launch that slips past the single-instance lock republishes
    // orca-runtime.json with its own pid, so the CLI reports stale_bootstrap
    // against this still-serving runtime once that instance exits.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()
    const published = readRuntimeMetadata(userDataPath)

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [{ kind: 'unix', endpoint: join(userDataPath, 'o-99999999-rt2.sock') }],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toEqual(published)

    await server.stop()
  })

  it('leaves runtime metadata owned by a live sibling runtime untouched', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Why: a synthetic owned pid frees the always-alive process.pid to stand in for
    // the sibling — Windows never assigns pid 1, so hardcoding it there reads as dead.
    const server = new OrcaRuntimeRpcServer({
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
    server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_live_sibling' })

    await server.stop()
  })

  it('stops reclaiming runtime metadata after the server is stopped', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({ runtime: new OrcaRuntimeService(), userDataPath })
    await server.start()
    const watch = server['metadataOwnershipWatch']
    if (!watch) {
      throw new Error('start() must arm the metadata ownership watch')
    }
    // Why: the republish guard alone would keep this test green, so assert the timer teardown itself.
    const watchStop = vi.spyOn(watch, 'stop')
    await server.stop()

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    server.checkRuntimeMetadataOwnership()

    expect(watchStop).toHaveBeenCalledTimes(1)
    expect(server['metadataOwnershipWatch']).toBeNull()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_second_instance' })
  })

  it('flushes a lastSeen refresh scheduled while transports stop', async () => {
    const server = new OrcaRuntimeRpcServer({
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
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
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
})
