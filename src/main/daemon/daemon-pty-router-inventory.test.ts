import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'
import { AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION } from './types'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

describe('DaemonPtyRouter inventory identity', () => {
  it.each(['current', 'legacy'] as const)(
    'lists only the authoritative %s incarnation when generations reuse an id',
    async (generation) => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter(
        'legacy',
        [],
        undefined,
        AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION - 1
      )
      const currentProcess = {
        id: 'shared',
        incarnationId: 'current-incarnation',
        cwd: '/current',
        title: 'current',
        rootProcessId: 101,
        foregroundProcess: 'current-agent',
        worktreeId: 'worktree'
      } satisfies PtyProcessInfo
      const legacyProcess = {
        id: 'shared',
        incarnationId: 'legacy-incarnation',
        cwd: '/legacy',
        title: 'legacy',
        rootProcessId: 202,
        foregroundProcess: 'legacy-agent',
        worktreeId: 'worktree'
      } satisfies PtyProcessInfo
      const owner = generation === 'current' ? current : legacy
      const other = generation === 'current' ? legacy : current
      const process = generation === 'current' ? currentProcess : legacyProcess
      vi.mocked(current.listProcesses).mockResolvedValue(
        generation === 'current' ? [currentProcess] : []
      )
      vi.mocked(legacy.listProcesses).mockResolvedValue(
        generation === 'legacy' ? [legacyProcess] : []
      )
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      await router.discoverLegacySessions()
      vi.mocked(current.listProcesses).mockResolvedValue([currentProcess])
      vi.mocked(legacy.listProcesses).mockResolvedValue([legacyProcess])

      await expect(router.listProcesses()).resolves.toEqual([process])
      expect(router.supportsFencedTermination('shared')).toBe(generation === 'current')
      expect(router.providesAgentSessionOwnerListings('shared')).toBe(generation === 'current')
      router.write('shared', 'still routed')
      expect(owner.write).toHaveBeenCalledExactlyOnceWith('shared', 'still routed')
      expect(other.write).not.toHaveBeenCalled()
      const request = {
        id: 'shared',
        expectedIncarnationId: process.incarnationId,
        requireNoAgentOwner: true,
        requireUnattached: true
      }
      await expect(router.killFenced(request)).resolves.toEqual(
        generation === 'current'
          ? { outcome: 'ended' }
          : { outcome: 'refused', reason: 'unsupported' }
      )
      if (generation === 'current') {
        expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
      }
      expect(legacy.killFenced).not.toHaveBeenCalled()
      expect(current.listProcesses).toHaveBeenCalledTimes(2)
      expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['distinct', 'identical', 'missing'] as const)(
    'rejects a complete inventory with unknown generation authority (%s incarnations)',
    async (incarnations) => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      vi.mocked(current.listProcesses).mockResolvedValue([
        {
          id: 'ambiguous',
          ...(incarnations !== 'missing' ? { incarnationId: 'current-incarnation' } : {}),
          cwd: '/current',
          title: 'current',
          worktreeId: 'worktree'
        }
      ])
      vi.mocked(legacy.listProcesses).mockResolvedValue([
        {
          id: 'ambiguous',
          ...(incarnations !== 'missing'
            ? {
                incarnationId:
                  incarnations === 'identical' ? 'current-incarnation' : 'legacy-incarnation'
              }
            : {}),
          cwd: '/legacy',
          title: 'legacy',
          worktreeId: 'worktree'
        }
      ])
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      // Why reject rather than drop the row: worktree removal treats a completed empty list
      // as exit proof; renderer bare-id deduplication would instead invent one row's authority.
      await expect(router.listProcesses()).rejects.toBeInstanceOf(
        TerminalSessionOwnerUnverifiedError
      )
      await expect(router.listProcesses({ includeUnrouted: true })).resolves.toEqual([
        expect.objectContaining({ id: 'ambiguous', cwd: '/current' }),
        expect.objectContaining({ id: 'ambiguous', cwd: '/legacy' })
      ])
      await expect(router.listProcesses()).rejects.toBeInstanceOf(
        TerminalSessionOwnerUnverifiedError
      )
      expect(router.supportsFencedTermination('ambiguous')).toBe(false)
      expect(router.providesAgentSessionOwnerListings('ambiguous')).toBe(false)
      await expect(
        router.spawn({ sessionId: 'ambiguous', attachOnly: true, cols: 80, rows: 24 })
      ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      await expect(router.probePtyLiveness('ambiguous')).resolves.toBe(true)
      expect(current.spawn).not.toHaveBeenCalled()
      expect(legacy.spawn).not.toHaveBeenCalled()
    }
  )

  it.each(['listing-first', 'attach-first'] as const)(
    'shares a healthy inventory with an exact reattach (%s)',
    async (order) => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      vi.mocked(current.listProcesses).mockResolvedValue([
        { id: 'session', incarnationId: 'A', cwd: '/', title: 'shell' }
      ])
      vi.mocked(current.spawn).mockResolvedValue({
        id: 'session',
        incarnationId: 'A',
        isReattach: true
      })
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      const listing = () => router.listProcesses({ includeUnrouted: true })
      const attach = () =>
        router.spawn({
          sessionId: 'session',
          expectedIncarnationId: 'A',
          expectedIncarnationIsAuthoritative: true,
          attachOnly: true,
          cols: 80,
          rows: 24
        })
      const results = await Promise.allSettled(
        order === 'listing-first' ? [listing(), attach()] : [attach(), listing()]
      )
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(current.listProcesses).toHaveBeenCalledOnce()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
    }
  )

  it('shares concurrent routed and diagnostic reads without weakening duplicate authority', async () => {
    const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
    const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
    vi.mocked(legacy.listProcesses).mockResolvedValue([
      { id: 'same', incarnationId: 'B', cwd: '/legacy', title: 'shell' }
    ])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: 'same', incarnationId: 'A', cwd: '/current', title: 'shell' }
    ])
    const [routed, diagnostic] = await Promise.all([
      router.listProcesses(),
      router.listProcesses({ includeUnrouted: true })
    ])
    expect(routed).toEqual([expect.objectContaining({ incarnationId: 'B' })])
    expect(diagnostic).toEqual([
      expect.objectContaining({ incarnationId: 'A', routed: false }),
      expect.objectContaining({ incarnationId: 'B', routed: true })
    ])
    await router.shutdown(routed[0]!.id, { immediate: true })
    expect(current.shutdown).not.toHaveBeenCalled()
    expect(legacy.shutdown).toHaveBeenCalledWith('same', { immediate: true })
  })

  it('assigns stable distinct sources when legacy daemons omit incarnations', async () => {
    const current = createAdapter('current', ['same'])
    const legacy = createAdapter('legacy', ['same'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const sessions = await router.listProcesses({ includeUnrouted: true })
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions.map((session) => session.inventorySourceId)).size).toBe(2)
    expect(
      sessions.every((session) => session.inventorySourceId && session.routed === undefined)
    ).toBe(true)
    expect(await router.listProcesses({ includeUnrouted: true })).toEqual(sessions)
  })

  it('bounds a joining caller without cancelling the shared inventory', async () => {
    vi.useFakeTimers()
    try {
      const current = createAdapter('current')
      const inventory = Promise.withResolvers<PtyProcessInfo[]>()
      vi.mocked(current.listProcesses).mockReturnValue(inventory.promise)
      const router = new DaemonPtyRouter({ current, legacy: [] })
      const ordinary = router.listProcesses()
      const short = router.listProcesses({ deadlineMs: Date.now() + 10 })
      const refused = expect(short).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      await vi.advanceTimersByTimeAsync(10)
      await refused
      inventory.resolve([{ id: 'live', cwd: '/', title: 'shell' }])
      await expect(ordinary).resolves.toEqual([{ id: 'live', cwd: '/', title: 'shell' }])
      expect(current.listProcesses).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
