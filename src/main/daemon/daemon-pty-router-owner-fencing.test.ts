import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { TerminalOwnerIdentity } from '../../shared/terminal-owner-identity'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

type FenceAdapter = DaemonPtyAdapter & {
  emitExit: (id: string, code: number, incarnationId: string) => void
  emitIdentityChange: () => void
}

function createFenceAdapter(label: string, initialSessions: string[] = []): FenceAdapter {
  const sessions = [...initialSessions]
  let exitListener: ((event: { id: string; code: number; incarnationId?: string }) => void) | null =
    null
  let identityChangeListener: (() => void) | null = null
  const noopSubscription = vi.fn(() => () => {})
  return {
    spawn: vi.fn(async (options: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = options.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id, incarnationId: `${label}:${id}` }
    }),
    listProcesses: vi.fn(async () =>
      sessions.map((id) => ({ id, incarnationId: `${label}:${id}`, cwd: '', title: label }))
    ),
    probePtyLiveness: vi.fn(async (id: string) => sessions.includes(id)),
    write: vi.fn(),
    shutdown: vi.fn(),
    onData: noopSubscription,
    onBackgroundStreamEvent: noopSubscription,
    onWriteUnavailable: noopSubscription,
    onExit: vi.fn((listener) => {
      exitListener = listener
      return () => {
        exitListener = null
      }
    }),
    onDaemonIdentityChanged: vi.fn((listener) => {
      identityChangeListener = listener
      return () => {
        identityChangeListener = null
      }
    }),
    emitExit: (id, code, incarnationId) => exitListener?.({ id, code, incarnationId }),
    emitIdentityChange: () => identityChangeListener?.()
  } as unknown as FenceAdapter
}

describe('DaemonPtyRouter owner fencing', () => {
  it('retains the exact owner route for a history-preserving stop', async () => {
    const current = createFenceAdapter('current')
    const legacy = createFenceAdapter('legacy', ['parked-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    const parkedOwner = {
      executionHostId: 'local',
      ownerKind: 'daemon',
      ownerIncarnationId: 'legacy-daemon',
      sessionIncarnationId: 'legacy:parked-session',
      protocolVersion: PROTOCOL_VERSION,
      endpointRef: 'daemon-v37'
    } satisfies TerminalOwnerIdentity
    legacy.getTerminalOwnerIdentity = vi.fn(() => parkedOwner)
    legacy.probePtyLiveness = vi.fn(async () => false)
    vi.mocked(legacy.shutdown).mockImplementation(async () => {
      legacy.emitExit('parked-session', -1, 'legacy:parked-session')
    })

    await router.shutdown('parked-session', { keepHistory: true })

    await expect(
      router.probePtyLiveness('parked-session', 'legacy:parked-session', parkedOwner)
    ).resolves.toBe(false)
    expect(legacy.probePtyLiveness).toHaveBeenCalledOnce()
    expect(current.probePtyLiveness).not.toHaveBeenCalled()
  })

  it('keeps replacement B routed after a delayed exit from owner A', async () => {
    const current = createFenceAdapter('current')
    const legacy = createFenceAdapter('legacy', ['reused-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    legacy.emitIdentityChange()
    await router.spawn({ cols: 80, rows: 24, sessionId: 'reused-session' })
    const routes = (router as unknown as { sessionAdapters: Map<string, DaemonPtyAdapter> })
      .sessionAdapters
    expect(routes.get('reused-session')).toBe(current)

    legacy.emitExit('reused-session', 0, 'legacy:reused-session')
    expect(routes.get('reused-session')).toBe(current)
    router.write('reused-session', 'replacement-marker')

    expect(current.write).toHaveBeenCalledWith('reused-session', 'replacement-marker')
    expect(legacy.write).not.toHaveBeenCalled()
    expect(current.shutdown).not.toHaveBeenCalled()
  })
})
