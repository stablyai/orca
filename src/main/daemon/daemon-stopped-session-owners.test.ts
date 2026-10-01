import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonStoppedSessionOwners } from './daemon-stopped-session-owners'

function owner(probe: (id: string) => Promise<boolean | null>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: confirm reads only probePtyLiveness.
  return { probePtyLiveness: vi.fn(probe) } as unknown as IPtyProvider
}

/** A daemon version holding `sessions`; `frozen` makes every request hang like a SIGSTOPed daemon. */
function version(protocolVersion: number, sessions: Set<string>, frozen = false): DaemonPtyAdapter {
  const hang = (): Promise<never> => new Promise(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the router's spawn, stop and confirm paths read only these members.
  return {
    protocolVersion,
    spawn: vi.fn(async (opts: { sessionId?: string }) => {
      sessions.add(opts.sessionId ?? 'new')
      return { id: opts.sessionId ?? 'new' }
    }),
    // Why in-memory: a real adapter answers hasPty from the ids it attached, even while frozen.
    hasPty: (id: string) => sessions.has(id),
    shutdown: vi.fn(async (id: string) => (frozen ? hang() : void sessions.delete(id))),
    probePtyLiveness: vi.fn(async (id: string) => (frozen ? null : sessions.has(id))),
    // Why honour the deadline: a real adapter's listing gives up at the caller's deadline.
    listProcesses: vi.fn(async (opts?: { deadlineMs?: number }) => {
      if (!frozen) {
        return [...sessions].map((id) => ({ id }))
      }
      const deadlineMs = opts?.deadlineMs
      if (deadlineMs === undefined) {
        return await hang()
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineMs - Date.now())))
      throw new Error('timed out')
    }),
    readProcesses: vi.fn(),
    getActiveSessionIds: () => [...sessions],
    onData: () => () => {},
    onBackgroundStreamEvent: () => () => {},
    onWriteUnavailable: () => () => {},
    onReplay: () => () => {},
    onExit: () => () => {},
    onDaemonIdentityChanged: () => () => {}
  } as unknown as DaemonPtyAdapter
}

describe('DaemonStoppedSessionOwners', () => {
  it('confirms a stop from the owner that did it, whatever other versions say', async () => {
    const owners = new DaemonStoppedSessionOwners<IPtyProvider>()
    const noOwnerProbe = vi.fn(async () => null)
    owners.record(
      'wt@@a',
      owner(async () => false)
    )

    await expect(owners.confirm('wt@@a', noOwnerProbe)).resolves.toBe(true)
    expect(noOwnerProbe).not.toHaveBeenCalled()
  })

  it('never reads a silent owner as a confirmed stop', async () => {
    const owners = new DaemonStoppedSessionOwners<IPtyProvider>()
    owners.record(
      'wt@@a',
      owner(async () => null)
    )
    owners.record(
      'wt@@b',
      owner(() => new Promise(() => {}))
    )

    await expect(owners.confirm('wt@@a', async () => false)).resolves.toBeNull()
    await expect(owners.confirm('wt@@b', async () => false, Date.now() + 20)).resolves.toBeNull()
  })

  it('answers within the caller deadline even when the owner is slow', async () => {
    const owners = new DaemonStoppedSessionOwners<IPtyProvider>()
    owners.record(
      'wt@@slow',
      owner(() => new Promise((resolve) => setTimeout(() => resolve(false), 1_500)))
    )
    const started = Date.now()

    await expect(owners.confirm('wt@@slow', async () => false, started + 100)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('falls back to the provider-wide probe once a new session reuses the id', async () => {
    const owners = new DaemonStoppedSessionOwners<IPtyProvider>()
    owners.record(
      'wt@@a',
      owner(async () => false)
    )
    owners.record('wt@@a', undefined)

    await expect(owners.confirm('wt@@a', async () => true)).resolves.toBe(false)
  })
})

describe('DaemonPtyRouter stop confirmation while a previous version is frozen', () => {
  it('confirms a current-version stop without asking the frozen version', async () => {
    const frozen = version(35, new Set(['wt@@old']), true)
    const current = version(36, new Set())
    const router = new DaemonPtyRouter({ current, legacy: [frozen] })
    await router.spawn({ sessionId: 'wt@@new', cols: 80, rows: 24 })

    await router.shutdown('wt@@new', { immediate: true })

    await expect(router.confirmPtyStopped('wt@@new')).resolves.toBe(true)
    expect(frozen.listProcesses).not.toHaveBeenCalled()
  })

  it('keeps the owner an earlier stop recorded when a later stop cannot find one', async () => {
    const frozen = version(35, new Set(['wt@@old']), true)
    const current = version(36, new Set())
    const router = new DaemonPtyRouter({ current, legacy: [frozen] })
    await router.spawn({ sessionId: 'wt@@new', cols: 80, rows: 24 })
    await router.shutdown('wt@@new', { immediate: true })

    // The id is gone from its owner and the frozen version cannot be asked, so no owner is found.
    await expect(router.shutdown('wt@@new', { immediate: true })).rejects.toThrow()

    await expect(router.confirmPtyStopped('wt@@new')).resolves.toBe(true)
  })

  it('never confirms a stop of a session the frozen version owns', async () => {
    const frozen = version(35, new Set(['wt@@old']), true)
    const current = version(36, new Set())
    const router = new DaemonPtyRouter({ current, legacy: [frozen] })

    const stop = router.shutdown('wt@@old', { immediate: true })
    void stop.catch(() => {})

    await expect(
      router.confirmPtyStopped('wt@@old', { deadlineMs: Date.now() + 50 })
    ).resolves.toBe(null)
  })
})
