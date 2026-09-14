import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { serveOrcaApp } from './launch'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn
}))

let profile: string
let endpoint: string
let server: Server | undefined
let endpointCount = 0
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'os-'))
  endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\orca-serve-test-${process.pid}-${endpointCount++}`
      : join(profile, 's')
  vi.stubEnv('ORCA_USER_DATA_PATH', profile)
  vi.stubEnv('ORCA_APP_EXECUTABLE', '/test-electron')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  spawn.mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  })
})
afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  server = undefined
  await rm(profile, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
async function publishEndpoint(): Promise<void> {
  await writeFile(
    getRuntimeMetadataPath(profile),
    JSON.stringify({
      pid: 1,
      authToken: 'test-only',
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
    })
  )
}
async function startListener(): Promise<void> {
  server = createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(endpoint, resolve)
  })
}

describe('serve against a real local listener', () => {
  it('refuses simultaneous calls against an existing listener, even with a recycled PID hint', async () => {
    spawn.mockImplementation(() => {
      throw new Error('unexpected duplicate launch')
    })
    await startListener()
    await publishEndpoint()
    await expect(
      Promise.all([
        serveOrcaApp({ json: true }),
        serveOrcaApp({ recipeJson: true, json: true, projectRoot: '/workspace' })
      ])
    ).resolves.toEqual([3, 3])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('allows an absent profile to reach the existing launch path', async () => {
    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('allows a published endpoint that no longer exists', async () => {
    await publishEndpoint()
    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('allows a profile after its listener stops without relying on the PID hint', async () => {
    await startListener()
    await publishEndpoint()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(spawn).toHaveBeenCalledOnce()
  })
})
