// The host half of #9819: a client may only reap a relay PTY it can prove it created, so the relay
// has to say who created each one. The attestation is read from the live consumer grant, never from
// a spawn parameter — otherwise it would just echo the caller's claim back at it.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../shared/process-table-snapshot-reader'

const PANE_KEY = 'tab-agent:22222222-2222-4222-8222-222222222222'

type Summary = {
  id: string
  paneBound?: boolean
  hostAgeMs?: number
  ownerClientInstanceId?: string
  foregroundProcessEvidence?: { capturedAgeMs: number }
}

describe('PtyHandler publishes host-attested PTY ownership', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  async function spawnFrom(
    clientId: number,
    params: Record<string, unknown> = {}
  ): Promise<{ id: string }> {
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
    return (await dispatcher.callRequest('pty.spawn', params, {
      clientId,
      isStale: () => false
    } as never)) as { id: string }
  }

  async function listProcesses(): Promise<Summary[]> {
    return (await dispatcher.callRequest('pty.listProcesses', {})) as Summary[]
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    handler.setConsumerIdentityResolver((clientId) => (clientId === 7 ? 'client-A' : null))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('attributes a pane spawn to the identity the consumer grant names', async () => {
    const { id } = await spawnFrom(7, { env: { ORCA_PANE_KEY: PANE_KEY } })
    vi.advanceTimersByTime(45_000)

    const entry = (await listProcesses()).find((process) => process.id === id)

    expect(entry?.ownerClientInstanceId).toBe('client-A')
    expect(entry?.paneBound).toBe(true)
    expect(entry?.hostAgeMs).toBeGreaterThanOrEqual(45_000)
  })

  it('omits the attestation entirely when the connection holds no active grant', async () => {
    const { id } = await spawnFrom(9, { env: { ORCA_PANE_KEY: PANE_KEY } })

    const entry = (await listProcesses()).find((process) => process.id === id)

    // Absent, not empty-string or null: a reader must be able to tell "unattested" from any value.
    expect(entry).not.toHaveProperty('ownerClientInstanceId')
  })

  it('never attests a revived PTY, so a restored session is not sweepable', async () => {
    // The load-bearing invariant of #9819's host half, and the one most likely to be "helpfully"
    // broken later: revive replays state a client serialized, which is not this host observing who
    // asked for the shell. A revived PTY *does* get paneBound: true (paneKey is restored) and a
    // fresh createdAt, so the omitted attestation is the only thing standing between a relay
    // restart and a sweep of the entire restored session.
    const revivedId = 'pty-revived-1'
    await dispatcher.callRequest(
      'pty.revive',
      {
        state: JSON.stringify([
          {
            id: revivedId,
            pid: process.pid,
            cwd: process.cwd(),
            paneKey: PANE_KEY,
            cols: 80,
            rows: 24
          }
        ])
      },
      { clientId: 7, isStale: () => false } as never
    )

    const entry = (await listProcesses()).find((process) => process.id === revivedId)
    expect(entry, 'revive should have produced a live PTY entry').toBeDefined()
    // paneBound is true, which is exactly why the missing attestation has to be asserted:
    // every other sweep precondition is satisfied by a revived pane.
    expect(entry?.paneBound).toBe(true)
    expect(entry?.ownerClientInstanceId).toBeUndefined()
  })

  it('reports a bare shell as not pane-bound', async () => {
    const { id } = await spawnFrom(7, {})

    const entry = (await listProcesses()).find((process) => process.id === id)

    expect(entry?.paneBound).toBe(false)
    expect(entry?.ownerClientInstanceId).toBe('client-A')
  })

  it('dates the foreground observation instead of stamping it fresh', async () => {
    // `capturedAgeMs` used to be a hardcoded 0 with no reader anywhere, so the one field that
    // exists to bound staleness asserted the evidence was never stale. It now carries the
    // actual age of the TTL-shared capture the record was derived from.
    const { id } = await spawnFrom(7, { env: { ORCA_PANE_KEY: PANE_KEY } })

    const entry = (await listProcesses()).find((process) => process.id === id)

    expect(entry?.foregroundProcessEvidence?.capturedAgeMs).toBeLessThanOrEqual(
      PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
    )
  })
})

// CodeRabbit's unaddressed note, and the asymmetry behind it: `pty.spawn` and `pty.attach` both
// take a request context and both check it, while `pty.shutdown` — the one call that irreversibly
// destroys a user's running process — took none, so the entire ownership rule was enforced only on
// the client that decided to make the call.
describe('PtyHandler authorizes a fenced stop against its own attestation', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  async function spawnFrom(clientId: number): Promise<{ id: string }> {
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
    return (await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: PANE_KEY } }, {
      clientId,
      isStale: () => false
    } as never)) as { id: string }
  }

  async function isStillHeld(id: string): Promise<boolean> {
    const entries = (await dispatcher.callRequest('pty.listProcesses', {})) as Summary[]
    return entries.some((entry) => entry.id === id)
  }

  /** What actually reaches the process. A refusal has to leave this untouched — the point of the
   *  check is the process, not the error. */
  function killSignals(): unknown[][] {
    return mockPtyInstance.kill.mock.calls
  }

  function stop(id: string, params: Record<string, unknown>, clientId: number): Promise<unknown> {
    return dispatcher.callRequest('pty.shutdown', { id, immediate: false, ...params }, {
      clientId,
      isStale: () => false
    } as never)
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    handler.setConsumerIdentityResolver((clientId) =>
      clientId === 7 ? 'client-A' : clientId === 8 ? 'client-B' : null
    )
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('stops a PTY when the connection and the host agree on the owner', async () => {
    const { id } = await spawnFrom(7)

    await expect(
      stop(id, { expectedOwnerClientInstanceId: 'client-A' }, 7)
    ).resolves.toBeUndefined()
    expect(killSignals()).toEqual([['SIGTERM']])
  })

  it('refuses when another client asserts our identity, and leaves the process running', async () => {
    // The claim is a parameter, so a confused or displaced client can send any value it likes.
    // What it cannot do is authenticate as that identity on this connection.
    const { id } = await spawnFrom(7)

    await expect(stop(id, { expectedOwnerClientInstanceId: 'client-A' }, 8)).rejects.toThrow(
      /requester is not the attested owner/
    )
    expect(killSignals()).toEqual([])
    expect(await isStillHeld(id)).toBe(true)
  })

  it('refuses when the connection holds no grant at all', async () => {
    const { id } = await spawnFrom(7)

    await expect(stop(id, { expectedOwnerClientInstanceId: 'client-A' }, 99)).rejects.toThrow(
      /requester is not the attested owner/
    )
    expect(killSignals()).toEqual([])
    expect(await isStillHeld(id)).toBe(true)
  })

  it('refuses a PTY this host never attested, even to the client that asked', async () => {
    // The revived-PTY case. Both sweep preconditions a client can see are satisfied — pane-bound,
    // old enough — and only the host knows it never recorded a creator for it.
    const revivedId = 'pty-revived-fence'
    await dispatcher.callRequest(
      'pty.revive',
      {
        state: JSON.stringify([
          {
            id: revivedId,
            pid: process.pid,
            cwd: process.cwd(),
            paneKey: PANE_KEY,
            cols: 80,
            rows: 24
          }
        ])
      },
      { clientId: 7, isStale: () => false } as never
    )

    await expect(stop(revivedId, { expectedOwnerClientInstanceId: 'client-A' }, 7)).rejects.toThrow(
      /this host attested no such owner/
    )
    expect(killSignals()).toEqual([])
    expect(await isStillHeld(revivedId)).toBe(true)
  })

  it('leaves an ordinary teardown that names no owner exactly as it was', async () => {
    // Rule 1's obligation: an old client, and every non-sweep caller on a current one, omits the
    // field. The host must not start refusing a stop it is obliged to honour.
    const { id } = await spawnFrom(7)

    await expect(stop(id, {}, 7)).resolves.toBeUndefined()
    expect(killSignals()).toEqual([['SIGTERM']])
  })

  it('rejects a malformed owner claim rather than ignoring it', async () => {
    const { id } = await spawnFrom(7)

    await expect(stop(id, { expectedOwnerClientInstanceId: '' }, 7)).rejects.toThrow(
      /Invalid expectedOwnerClientInstanceId/
    )
    expect(killSignals()).toEqual([])
    expect(await isStillHeld(id)).toBe(true)
  })
})
