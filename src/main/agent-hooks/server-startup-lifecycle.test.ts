import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import type { drainAgentHookSpoolAsync } from '../../shared/agent-hook-spool'
import type * as HookSpoolModule from '../../shared/agent-hook-spool'
import { getEndpointFileName } from '../../shared/agent-hook-listener/endpoint-publication'

const drain = vi.hoisted(() => vi.fn<typeof drainAgentHookSpoolAsync>())
vi.mock('../../shared/agent-hook-spool', async (importOriginal) => ({
  ...(await importOriginal<typeof HookSpoolModule>()),
  drainAgentHookSpoolAsync: drain
}))

const directories: string[] = []
const servers: { stop: () => void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  drain.mockReset()
})

function fixture(mode: 'main' | 'relay') {
  const directory = mkdtempSync(join(tmpdir(), 'hook-startup-'))
  directories.push(directory)
  if (mode === 'main') {
    const server = new AgentHookServer()
    servers.push(server)
    return {
      start: () => server.start({ env: 'production', userDataPath: directory }),
      stop: () => server.stop(),
      port: () => Number(server.buildPtyEnv().ORCA_AGENT_HOOK_PORT ?? 0),
      endpoint: join(directory, 'agent-hooks', getEndpointFileName())
    }
  }
  const server = new RelayAgentHookServer({ endpointDir: directory, forward: vi.fn() })
  servers.push(server)
  return {
    start: () => server.start(),
    stop: () => server.stop(),
    port: () => server.getCoordinates().port,
    endpoint: server.getCoordinates().endpointFilePath
  }
}

function pauseReplay() {
  let release: (() => void) | undefined
  drain.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(0)
      })
  )
  return () => release?.()
}

it.each(['main', 'relay'] as const)(
  'shares one %s startup while replay is pending',
  async (mode) => {
    const server = fixture(mode)
    const release = pauseReplay()
    const first = server.start()
    const second = server.start()
    expect(second).toBe(first)
    expect(drain).toHaveBeenCalledTimes(1)
    expect(server.port()).toBe(0)
    release()
    await Promise.all([first, second])
    expect(server.port()).toBeGreaterThan(0)
    expect(existsSync(server.endpoint)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${server.port()}`)).status).toBe(404)
  }
)

it.each(['main', 'relay'] as const)(
  'does not bind a %s listener after stop interrupts replay',
  async (mode) => {
    const server = fixture(mode)
    const release = pauseReplay()
    const starting = server.start()
    server.stop()
    release()
    await starting
    expect(server.port()).toBe(0)
    expect(existsSync(server.endpoint)).toBe(false)
  }
)

it.each(['main', 'relay'] as const)(
  'restarts %s after an interrupted startup settles',
  async (mode) => {
    const server = fixture(mode)
    const release = pauseReplay()
    const first = server.start()
    server.stop()
    drain.mockResolvedValue(0)
    const restarted = server.start()
    expect(drain).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, restarted])
    expect(drain).toHaveBeenCalledTimes(2)
    expect(server.port()).toBeGreaterThan(0)
    expect(existsSync(server.endpoint)).toBe(true)
  }
)

it('allows a fresh main startup after replay admission rejects', async () => {
  const server = fixture('main')
  drain.mockRejectedValueOnce(new Error('admission unavailable'))
  await expect(server.start()).rejects.toThrow('admission unavailable')
  expect(server.port()).toBe(0)
  drain.mockResolvedValue(0)
  await server.start()
  expect(server.port()).toBeGreaterThan(0)
  expect(existsSync(server.endpoint)).toBe(true)
})

it.each(['main', 'relay'] as const)(
  'cancels a queued %s restart when stopped again before replay settles',
  async (mode) => {
    const server = fixture(mode)
    const release = pauseReplay()
    const first = server.start()
    server.stop()
    const restarted = server.start()
    server.stop()
    release()
    await Promise.all([first, restarted])
    expect(drain).toHaveBeenCalledTimes(1)
    expect(server.port()).toBe(0)
    expect(existsSync(server.endpoint)).toBe(false)
  }
)
