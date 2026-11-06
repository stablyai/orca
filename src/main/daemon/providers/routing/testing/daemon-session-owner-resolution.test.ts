import { describe, expect, it, vi } from 'vitest'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../../providers/pty-provider-contract'
import {
  SessionNotFoundError,
  TerminalSessionOwnerUnverifiedError
} from '../../../protocol/daemon-errors'
import { DaemonSessionOwnerResolver } from '../daemon-session-owner-resolution'
import { terminateResolvedDaemonSession } from '../../../server/daemon-fenced-termination'

function provider(
  processes: () => Promise<PtyProcessInfo[]>,
  spawn: (opts: PtySpawnOptions) => Promise<PtySpawnResult> = async (opts) => ({
    id: opts.sessionId ?? 'new'
  })
): IPtyProvider {
  return {
    listProcesses: vi.fn(processes),
    spawn: vi.fn(spawn)
  } as unknown as IPtyProvider
}

describe('DaemonSessionOwnerResolver', () => {
  it('does not use cached absence as checked-termination proof for a newly discovered session', async () => {
    const sessions = [{ id: 'existing', incarnationId: 'current', cwd: '', title: 'existing' }]
    const owner = provider(async () => [...sessions])
    owner.supportsFencedTermination = () => true
    owner.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    await expect(resolver.resolve('existing', 'replaced', true)).resolves.toEqual({
      kind: 'unknown'
    })
    sessions.push({ id: 'new-session', incarnationId: 'new', cwd: '', title: 'new' })
    const request = {
      id: 'new-session',
      expectedIncarnationId: 'new',
      requireNoAgentOwner: true,
      requireUnattached: true
    }

    await expect(
      terminateResolvedDaemonSession(request, () => resolver.resolveTermination(request.id, 'new'))
    ).resolves.toEqual({ outcome: 'ended' })
    expect(owner.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('dispatches to an exact spawn owner without accepting pre-spawn in-flight absence', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<PtyProcessInfo[]>()
    const owner = provider(() => gate)
    owner.supportsFencedTermination = () => true
    owner.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const oldInventory = resolver.resolve('unrelated')
    resolver.recordRoute('new-session', owner, 'new')
    const request = {
      id: 'new-session',
      expectedIncarnationId: 'new',
      requireNoAgentOwner: true,
      requireUnattached: true
    }
    const termination = terminateResolvedDaemonSession(request, () =>
      resolver.resolveTermination(request.id, 'new')
    )
    release([])

    await expect(termination).resolves.toEqual({ outcome: 'ended' })
    await expect(oldInventory).resolves.toEqual({ kind: 'unknown' })
    expect(owner.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    expect(owner.listProcesses).toHaveBeenCalledOnce()
  })

  it('requires post-spawn inventory when a new route has no exact incarnation proof', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<PtyProcessInfo[]>()
    const inventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockReturnValueOnce(gate)
      .mockResolvedValueOnce([{ id: 'new-session', incarnationId: 'new', cwd: '', title: 'new' }])
    const owner = provider(inventory)
    owner.supportsFencedTermination = () => true
    owner.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const oldInventory = resolver.resolve('unrelated')
    resolver.recordRoute('new-session', owner)
    const request = {
      id: 'new-session',
      expectedIncarnationId: 'new',
      requireNoAgentOwner: true,
      requireUnattached: true
    }
    const termination = terminateResolvedDaemonSession(request, () =>
      resolver.resolveTermination(request.id, 'new')
    )
    release([])

    await expect(termination).resolves.toEqual({ outcome: 'ended' })
    await expect(oldInventory).resolves.toEqual({ kind: 'unknown' })
    expect(owner.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('re-resolves a routed incarnation mismatch against every possible owner', async () => {
    const staleRoute = provider(
      async () => [{ id: 'session', incarnationId: 'other', cwd: '', title: 'stale' }],
      async () => ({ id: 'session', incarnationId: 'other', isReattach: true })
    )
    const exactOwner = provider(
      async () => [{ id: 'session', incarnationId: 'expected', cwd: '', title: 'exact' }],
      async () => ({ id: 'session', incarnationId: 'expected', isReattach: true })
    )
    const resolver = new DaemonSessionOwnerResolver(
      [staleRoute, exactOwner],
      new Map([['session', staleRoute]])
    )

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'session',
        expectedIncarnationId: 'expected',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ incarnationId: 'expected' })
    expect(staleRoute.spawn).not.toHaveBeenCalled()
  })

  it('refreshes incomplete inventory when a routed owner refuses a moved session', async () => {
    let firstOwnsSession = true
    let secondOwnsSession = false
    const first = provider(
      async () =>
        firstOwnsSession
          ? [{ id: 'session', incarnationId: 'runtime', cwd: '', title: 'first' }]
          : [],
      async () => {
        throw new SessionNotFoundError('session')
      }
    )
    const second = provider(
      async () =>
        secondOwnsSession
          ? [{ id: 'session', incarnationId: 'runtime', cwd: '', title: 'second' }]
          : [],
      async () => ({ id: 'session', incarnationId: 'runtime', isReattach: true })
    )
    const unavailable = provider(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver([first, second, unavailable], new Map())

    await expect(resolver.resolve('session', 'runtime', true)).resolves.toMatchObject({
      kind: 'owner',
      provider: first
    })
    firstOwnsSession = false
    secondOwnsSession = true

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'session',
        expectedIncarnationId: 'runtime',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'session', incarnationId: 'runtime', isReattach: true })
    expect(first.spawn).toHaveBeenCalledOnce()
    expect(second.spawn).toHaveBeenCalledOnce()
    expect(second.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('fails closed across identity replacement then confirms absence on retry', async () => {
    let releaseCurrent!: (processes: PtyProcessInfo[]) => void
    let releaseLegacy!: (processes: PtyProcessInfo[]) => void
    const currentGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseCurrent = resolve
    })
    const legacyGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseLegacy = resolve
    })
    const currentInventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockReturnValueOnce(currentGate)
      .mockResolvedValueOnce([])
    const legacyInventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockReturnValueOnce(legacyGate)
      .mockResolvedValueOnce([])
    const current = provider(currentInventory)
    const legacy = provider(legacyInventory)
    const resolver = new DaemonSessionOwnerResolver([current, legacy], new Map())
    const attach = {
      sessionId: 'pty-persisted-after-identity-change',
      expectedIncarnationId: 'incarnation-before-identity-change',
      attachOnly: true,
      cols: 80,
      rows: 24
    } as const

    const staleAttempt = resolver.spawnAttachOnly(attach)
    expect(currentInventory).toHaveBeenCalledOnce()
    expect(legacyInventory).toHaveBeenCalledOnce()
    resolver.invalidateProvider(current)
    releaseCurrent([])
    releaseLegacy([])

    await expect(staleAttempt).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()

    await expect(resolver.spawnAttachOnly(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(currentInventory).toHaveBeenCalledTimes(2)
    expect(legacyInventory).toHaveBeenCalledTimes(2)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })
})
