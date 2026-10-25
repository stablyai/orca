import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as CryptoModule from 'node:crypto'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { DaemonClientConnections } from './daemon-client-connections'
import { TerminalHost } from './terminal-host'
import { Session } from './session'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'

type MockSubprocess = SubprocessHandle & { exit: () => void }
const seed = vi.hoisted(() => ({ uuid: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof CryptoModule>()
  return {
    ...original,
    randomUUID: () => `00000000-0000-4000-8000-${String(++seed.uuid).padStart(12, '0')}`
  }
})
const clients: DaemonClient[] = []
const processes: MockSubprocess[] = []
let dir = ''
let server: DaemonServer | undefined

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error('Daemon event did not settle')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function spawn(): MockSubprocess {
  let exited: ((code: number) => void) | undefined
  const proc: MockSubprocess = {
    pid: 90_001,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: () => exited?.(0),
    forceKill: () => exited?.(137),
    terminateOwnedTree: () => 'unavailable',
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      exited = callback
    },
    dispose: vi.fn(),
    exit: () => exited?.(0)
  }
  processes.push(proc)
  return proc
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-idle-inventory-'))
  clients.length = 0
  processes.length = 0
  seed.uuid = 0
})

afterEach(async () => {
  for (const process of processes) {
    process.exit()
  }
  for (const client of clients) {
    client.disconnect()
  }
  await server?.shutdown()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

it('keeps live sessions and exact inventories while visitors repeatedly disconnect', async () => {
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'daemon.token')
  const idle = vi.fn()
  const getClient = vi.spyOn(DaemonClientConnections.prototype, 'get')
  const create = vi.spyOn(TerminalHost.prototype, 'createOrAttach')
  server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawn, onIdleShutdown: idle })
  await server.start()
  const owner = new DaemonClient({ socketPath, tokenPath })
  clients.push(owner)
  await owner.ensureConnected()
  for (let index = 0; index < 16; index++) {
    await owner.request('createOrAttach', {
      sessionId: `session-${index}`,
      cols: 80,
      rows: 24,
      ...(index < 8
        ? {
            agentSessionEnsure: {
              claim: {
                digestVersion: 1,
                keyId: `key${index}`,
                identityDigest: 'a'.repeat(43),
                worktreeScopeDigest: 'b'.repeat(43),
                agent: 'codex'
              },
              surface: {
                worktreeId: `folder${index}`,
                tabId: '11111111-1111-4111-8111-111111111111',
                leafId: '22222222-2222-4222-8222-222222222222',
                terminalHandle: `term_idle${index}`
              }
            }
          }
        : {})
    })
  }
  const connections = getClient.mock.contexts[0]
  if (!(connections instanceof DaemonClientConnections)) {
    throw new Error('Actual server connections were not used')
  }
  const before = await owner.request('listSessions', undefined)
  const expected = structuredClone(before)
  if (
    typeof before !== 'object' ||
    before === null ||
    !('sessions' in before) ||
    !Array.isArray(before.sessions)
  ) {
    throw new Error('Initial inventory was malformed')
  }
  const first = before.sessions[0]
  if (
    typeof first !== 'object' ||
    first === null ||
    !('agentSessionOwners' in first) ||
    !Array.isArray(first.agentSessionOwners) ||
    !first.agentSessionOwners.every(isAgentSessionOwnerBinding)
  ) {
    throw new Error('Initial owners were malformed')
  }
  const priorOwner = first.agentSessionOwners[0]
  priorOwner.claim.keyId = 'mutated-client-copy'
  priorOwner.surface.terminalHandle = 'term_mutated'
  const inventory = vi.spyOn(TerminalHost.prototype, 'listSessions')
  const owners = vi.spyOn(ClaimedAgentPtyOwnerRegistry.prototype, 'listForPty')
  const sizes = vi.spyOn(Session.prototype, 'getAppliedSize')
  const cwds = vi.spyOn(Session.prototype, 'getCwd')
  const originalAlive = Object.getOwnPropertyDescriptor(Session.prototype, 'isAlive')?.get
  if (!originalAlive) {
    throw new Error('Session alive getter is missing')
  }
  const alive = vi.spyOn(Session.prototype, 'isAlive', 'get')
  for (let iteration = 0; iteration < 10; iteration++) {
    const visitor = new DaemonClient({ socketPath, tokenPath })
    clients.push(visitor)
    await visitor.ensureConnected()
    expect(await visitor.request('ping', undefined)).toEqual({ pong: true })
    visitor.disconnect()
    await waitFor(() => connections.size === 1 && connections.transportCount === 2)
    expect(idle).not.toHaveBeenCalled()
  }
  const calls = inventory.mock.calls.length
  const sizeCalls = sizes.mock.calls.length
  const cwdCalls = cwds.mock.calls.length
  const readSessionIds = (): string[] =>
    alive.mock.contexts.map((session) => {
      if (!(session instanceof Session)) {
        throw new Error('Actual Session was not read')
      }
      return session.sessionId
    })
  const aliveReads = readSessionIds()
  const ownerCalls = owners.mock.calls.length
  const copiedOwners = owners.mock.results.reduce((total, result) => {
    const value: unknown = result.value
    if (!Array.isArray(value)) {
      throw new Error('Owner result was not an array')
    }
    return total + value.length
  }, 0)
  const after = await owner.request('listSessions', undefined)
  expect(after).toEqual(expected)
  expect(JSON.stringify(after)).toBe(JSON.stringify(expected))
  expect(after).not.toBe(before)
  if (
    typeof after !== 'object' ||
    after === null ||
    !('sessions' in after) ||
    !Array.isArray(after.sessions)
  ) {
    throw new Error('Fresh inventory was malformed')
  }
  const fresh = after.sessions[0]
  if (
    typeof fresh !== 'object' ||
    fresh === null ||
    !('agentSessionOwners' in fresh) ||
    !Array.isArray(fresh.agentSessionOwners) ||
    !fresh.agentSessionOwners.every(isAgentSessionOwnerBinding)
  ) {
    throw new Error('Fresh owners were malformed')
  }
  expect(fresh.agentSessionOwners).not.toBe(first.agentSessionOwners)
  expect(fresh.agentSessionOwners[0]).not.toBe(priorOwner)
  expect(fresh.agentSessionOwners[0].claim).not.toBe(priorOwner.claim)
  expect(fresh.agentSessionOwners[0].surface).not.toBe(priorOwner.surface)
  expect(idle).not.toHaveBeenCalled()
  const host = create.mock.contexts[0]
  if (!(host instanceof TerminalHost)) {
    throw new Error('Actual host was not used')
  }
  const hasLive = (): boolean => {
    const candidate: unknown = host
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'hasLiveSessions' in candidate &&
      typeof candidate.hasLiveSessions === 'function'
    ) {
      const result: unknown = candidate.hasLiveSessions()
      if (typeof result !== 'boolean') {
        throw new Error('Live result was not boolean')
      }
      return result
    }
    return host.listSessions().length > 0
  }
  const readAlive = (session: Session): boolean => {
    const result: unknown = originalAlive.call(session)
    if (typeof result !== 'boolean') {
      throw new Error('Original alive getter was malformed')
    }
    return result
  }
  const controlReads: string[][] = []
  const failure = new Error('later-session-alive-failure')
  alive.mockImplementation(function (this: Session) {
    if (this.sessionId === 'session-1') {
      throw failure
    }
    return readAlive(this)
  })
  let caught: unknown
  try {
    hasLive()
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  const sessionIds = Array.from({ length: 16 }, (_value, index) => `session-${index}`)
  const deadIds = new Set(sessionIds)
  alive.mockClear().mockImplementation(function (this: Session) {
    return !deadIds.has(this.sessionId) && readAlive(this)
  })
  expect(hasLive()).toBe(false)
  controlReads.push(readSessionIds())
  deadIds.delete('session-3')
  alive.mockClear()
  expect(hasLive()).toBe(true)
  controlReads.push(readSessionIds())
  deadIds.add('session-3')
  alive.mockClear()
  expect(hasLive()).toBe(false)
  controlReads.push(readSessionIds())
  let entered = false
  let nested: boolean | undefined
  alive.mockClear().mockImplementation(function (this: Session) {
    if (!entered) {
      entered = true
      processes[1].exit()
      nested = hasLive()
    }
    return readAlive(this)
  })
  expect(hasLive()).toBe(true)
  expect(nested).toBe(true)
  controlReads.push(readSessionIds())
  alive.mockRestore()
  if (
    typeof expected !== 'object' ||
    expected === null ||
    !('sessions' in expected) ||
    !Array.isArray(expected.sessions)
  ) {
    throw new Error('Inventory was malformed')
  }
  const remaining = {
    ...expected,
    sessions: expected.sessions.filter(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'sessionId' in row &&
        row.sessionId !== 'session-1'
    )
  }
  const afterExit = await owner.request('listSessions', undefined)
  expect(afterExit).toEqual(remaining)
  expect(JSON.stringify(afterExit)).toBe(JSON.stringify(remaining))
  expect(aliveReads).toEqual(Array.from({ length: 30 }, () => sessionIds).flat())
  const remainingIds = sessionIds.filter((id) => id !== 'session-1')
  expect(controlReads).toEqual([
    sessionIds,
    sessionIds,
    sessionIds,
    [
      sessionIds[0],
      ...sessionIds,
      sessionIds[1],
      ...remainingIds,
      ...remainingIds,
      ...sessionIds.slice(2)
    ]
  ])
  expect(calls).toBe(0)
  expect(ownerCalls).toBe(0)
  expect(copiedOwners).toBe(0)
  expect(sizeCalls).toBe(0)
  expect(cwdCalls).toBe(0)
})
