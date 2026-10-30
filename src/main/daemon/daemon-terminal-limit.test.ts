import type * as FileSystem from 'node:fs/promises'
import './mock-descendant-sweep'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { HostTerminalPolicy } from './host-terminal-policy'
import { SystemPtyLimit } from './system-pty-limit'
import type { TerminalLimitStatus } from '../../shared/terminal-limit-policy'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), rm: vi.fn(fs.rm) }
})

const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')

let server: DaemonServer | undefined
let client: DaemonClient | undefined
let directory: string | undefined
afterEach(async () => {
  client?.disconnect()
  await server?.shutdown()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

it('reads and saves on the attached daemon socket, refusing stale identity and lost endpoint writes', async () => {
  directory = mkdtempSync(join(tmpdir(), 'terminal-limit-rpc-'))
  const path = join(directory, 'policy', 'terminals.json')
  await fs.mkdir(join(directory, 'policy'), { mode: 0o700 })
  await fs.writeFile(path, 'invalid JSON')
  server = new DaemonServer({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token'),
    terminalLimitPolicy: new HostTerminalPolicy(path, {}, new SystemPtyLimit(async () => 511)),
    spawnSubprocess: async () => createMockSubprocess()
  })
  await server.start()
  client = new DaemonClient({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token')
  })
  await client.ensureConnected()
  const before = await client.request<TerminalLimitStatus>('terminalLimitStatus', undefined)
  expect(before).toMatchObject({
    maxTerminals: 256,
    systemPtyLimit: 511,
    source: 'default',
    editable: true,
    savedUnreadable: true
  })
  const repaired = await client.request<TerminalLimitStatus>('setTerminalLimit', {
    daemonNonce: before.daemonNonce,
    maxTerminals: 256
  })
  expect(repaired.maxTerminals).toBe(256)
  expect(repaired.savedUnreadable).toBeUndefined()
  const update = { daemonNonce: before.daemonNonce, maxTerminals: 384 }
  await expect(client.request('setTerminalLimit', update)).resolves.toMatchObject({
    maxTerminals: 384,
    source: 'saved'
  })
  const saved = readFileSync(path, 'utf8')
  await expect(
    client.request('setTerminalLimit', { ...update, maxTerminals: 512 })
  ).rejects.toThrow('capacity')
  await expect(
    client.request('setTerminalLimit', { ...update, daemonNonce: 'other-daemon', maxTerminals: 20 })
  ).rejects.toThrow('changed')
  vi.spyOn(server['endpoint'], 'hasLostOwnership').mockReturnValue(true)
  await expect(client.request('setTerminalLimit', { ...update, maxTerminals: 20 })).rejects.toThrow(
    'host changed'
  )
  expect(readFileSync(path, 'utf8')).toBe(saved)
})

it('recognizes an older daemon without replacement and preserves real transport failures', async () => {
  vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
  const request = vi
    .spyOn(DaemonClient.prototype, 'request')
    .mockRejectedValue(new Error('Unknown request type: terminalLimitStatus'))
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-limit-old.sock',
    tokenPath: '/tmp/orca-limit-old.token'
  })
  try {
    await expect(adapter.terminalLimit()).resolves.toBeNull()
    request.mockRejectedValue(new Error('socket closed'))
    await expect(adapter.terminalLimit()).rejects.toThrow('socket closed')
  } finally {
    adapter.dispose()
  }
})

it('fences an actual pending save when the server shuts down before replacement', async () => {
  directory = mkdtempSync(join(tmpdir(), 'terminal-limit-shutdown-'))
  const path = join(directory, 'policy', 'terminals.json')
  server = new DaemonServer({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token'),
    terminalLimitPolicy: new HostTerminalPolicy(path, {}, new SystemPtyLimit(async () => 511)),
    spawnSubprocess: async () => createMockSubprocess()
  })
  await server.start()
  client = new DaemonClient({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token')
  })
  await client.ensureConnected()
  const before = await client.request<TerminalLimitStatus>('terminalLimitStatus', undefined)
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const staging = new Promise<void>((done) => {
    started = done
  })
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    started()
    await held
    await fs.writeFile(...args)
  })
  let cleaned!: () => void
  const cleanup = new Promise<void>((done) => {
    cleaned = done
  })
  vi.mocked(rm).mockImplementationOnce(async (...args) => {
    await fs.rm(...args)
    cleaned()
  })
  const save = client.request('setTerminalLimit', {
    daemonNonce: before.daemonNonce,
    maxTerminals: 10
  })
  const failed = expect(save).rejects.toThrow()
  await staging
  await server.shutdown()
  release()
  await failed
  await cleanup
  expect(await fs.readdir(join(directory, 'policy'))).toEqual([])
  expect(() => readFileSync(path)).toThrow()
})
