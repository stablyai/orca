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
      // Why: the websocket entry must not be picked — it is reachable from
      // anywhere on the network and proves nothing about this profile's owner.
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
    // Why: this is the case the pid could never distinguish — the owner is alive
    // and holding the profile, it just has not answered RPC yet.
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
    // Why: a runtime unlinks its socket on shutdown. Reading that as an owner is
    // what makes a stale profile refuse serve forever.
    await expect(probeRuntimeListener(metadataFor(nextEndpoint()))).resolves.toBe('not-listening')
  })

  it.skipIf(process.platform === 'win32')(
    'frees a profile whose owner was killed with its socket file still on disk',
    async () => {
      // Why: this is the STA-4336 crash shape — SIGKILL skips the unlink, so the path
      // survives and only its refusal distinguishes it from a live owner.
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
      // Why: only ENOENT/ECONNREFUSED disown an endpoint. Anything else — here an
      // unreadable directory — leaves an owner possible, and guessing "free" is
      // what spawns the second main that aborts pre-JS.
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
    // Why: the cap keeps this off the launch path's critical time, but a connect that
    // ran out of time proved nothing. Fake timers fire the cap before the real connect
    // can settle, which is the only way to reach that branch deterministically.
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
    // Why: the metadata file is unvalidated JSON. A missing or blank endpoint throws
    // out of createConnection and would fail serve outright, and a number is read as a
    // TCP port — 127.0.0.1:42 could be answered by something that is not Orca at all.
    const metadata = metadataFor(nextEndpoint())

    await expect(
      probeRuntimeListener({
        ...metadata,
        transports: [{ kind: metadata.transports[0]!.kind, endpoint: value as string }]
      })
    ).resolves.toBe('not-listening')
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
