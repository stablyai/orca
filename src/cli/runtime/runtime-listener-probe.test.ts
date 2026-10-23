import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { probeRuntimeListener, RUNTIME_LISTENER_PROBE_TIMEOUT_MS } from './runtime-listener-probe'

const servers = new Set<Server>()
const sockets = new Set<Socket>()
const lockedDirs = new Set<string>()
let endpointCount = 0

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
  for (const dir of lockedDirs) {
    chmodSync(dir, 0o700)
  }
  lockedDirs.clear()
})

function metadataFor(endpoint: string): RuntimeMetadata {
  return {
    runtimeId: 'runtime-1',
    pid: process.pid,
    transports: [
      { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint },
      // Network reachability does not prove ownership of this local profile.
      { kind: 'websocket', endpoint: 'ws://127.0.0.1:1' }
    ],
    authToken: 'token',
    startedAt: Date.now()
  }
}

function nextEndpoint(): string {
  endpointCount += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orca-probe-${process.pid}-${endpointCount}`
    : join(mkdtempSync(join(tmpdir(), 'orca-probe-')), 'runtime.sock')
}

describe('probeRuntimeListener', () => {
  it('accepts a runtime that is listening but silent', async () => {
    const endpoint = nextEndpoint()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    await expect(probeRuntimeListener(metadataFor(endpoint))).resolves.toBe('accepting')
  })

  it('frees a profile whose endpoint was never bound', async () => {
    await expect(probeRuntimeListener(metadataFor(nextEndpoint()))).resolves.toBe('not-listening')
  })

  it.skipIf(process.platform === 'win32')(
    'frees a profile whose owner was killed with its socket file still on disk',
    async () => {
      // SIGKILL leaves the socket path behind; connection refusal proves absence.
      const endpoint = nextEndpoint()
      const child = spawn(process.execPath, [
        '-e',
        `require('net').createServer(()=>{}).listen(${JSON.stringify(endpoint)},()=>console.log('up'))`
      ])
      await new Promise((resolve) => child.stdout.once('data', resolve))
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))

      await expect(probeRuntimeListener(metadataFor(endpoint))).resolves.toBe('not-listening')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses to call a profile free when the endpoint could not be reached at all',
    async () => {
      // Permission errors cannot prove the profile is free for another Electron main.
      const dir = join(mkdtempSync(join(tmpdir(), 'orca-probe-')), 'locked')
      mkdirSync(dir)
      chmodSync(dir, 0o000)
      lockedDirs.add(dir)

      await expect(probeRuntimeListener(metadataFor(join(dir, 'runtime.sock')))).resolves.toBe(
        'unproven'
      )
    }
  )

  it('refuses to call a profile free when a connect neither lands nor is refused', async () => {
    // Fake timers expire the probe before a real connection can settle.
    vi.useFakeTimers()
    try {
      const probe = probeRuntimeListener(metadataFor(nextEndpoint()))
      vi.advanceTimersByTime(RUNTIME_LISTENER_PROBE_TIMEOUT_MS)

      await expect(probe).resolves.toBe('unproven')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a missing endpoint', undefined],
    ['a blank endpoint', '   '],
    ['a numeric endpoint', 42]
  ])('frees a profile whose metadata carries %s instead of dialling it', async (_label, value) => {
    // Invalid endpoints can throw or dial an unrelated numeric TCP port.
    const metadata = metadataFor(nextEndpoint())
    const transport = { ...metadata.transports[0]! }
    Object.assign(transport, { endpoint: value })

    await expect(probeRuntimeListener({ ...metadata, transports: [transport] })).resolves.toBe(
      'not-listening'
    )
  })

  it('frees a profile whose metadata published no local transport to probe', async () => {
    const metadata = metadataFor(nextEndpoint())

    await expect(
      probeRuntimeListener({
        ...metadata,
        transports: metadata.transports.filter((transport) => transport.kind === 'websocket')
      })
    ).resolves.toBe('not-listening')
  })
})
