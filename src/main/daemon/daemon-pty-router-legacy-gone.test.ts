import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const LIVE_PID = 4242
const EXITED_PID = 4343

vi.mock('./daemon-process-inspection', () => ({
  inspectProcessSignal: (pid: number) => (pid === EXITED_PID ? 'missing' : 'occupied')
}))

function adapter(
  label: string,
  sessions: string[] = [],
  pid: number | null = EXITED_PID
): DaemonPtyAdapter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the router only calls these members on this path.
  return {
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    disconnectOnly: vi.fn(async () => {}),
    getDaemonIdentity: vi.fn(() =>
      pid === null ? null : { pid, startedAtMs: 1, launchNonce: label }
    ),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onBackgroundStreamEvent: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

function connectError(code: 'ECONNREFUSED' | 'ENOENT' | 'ECONNRESET', syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

describe('DaemonPtyRouter legacy socket that can never answer', () => {
  // Legacy PID-only exit proof remains unsupported on Windows.
  it.skipIf(process.platform === 'win32')(
    'drops a refused or missing legacy socket and does not ask it again',
    async () => {
      const current = adapter('current', ['current-session'])
      const refused = adapter('refused')
      const missing = adapter('missing')
      vi.mocked(refused.listProcesses).mockRejectedValue(connectError('ECONNREFUSED', 'connect'))
      vi.mocked(missing.listProcesses).mockRejectedValue(connectError('ENOENT', 'connect'))
      vi.mocked(refused.disconnectOnly).mockRejectedValue(new Error('already closed'))
      const router = new DaemonPtyRouter({ current, legacy: [refused, missing] })
      const sessions = [{ id: 'current-session', cwd: '', title: 'current' }]

      await expect(router.listProcesses()).resolves.toEqual(sessions)
      await expect(router.listProcesses()).resolves.toEqual(sessions)

      expect(refused.listProcesses).toHaveBeenCalledOnce()
      expect(missing.listProcesses).toHaveBeenCalledOnce()
      expect(refused.disconnectOnly).toHaveBeenCalledOnce()
      expect(router.getLegacyAdapters()).toEqual([])

      await router.discoverLegacySessions()
      router.onBackgroundStreamEvent(() => {})
      expect(refused.listProcesses).toHaveBeenCalledOnce()
      expect(missing.listProcesses).toHaveBeenCalledOnce()
      expect(refused.onBackgroundStreamEvent).not.toHaveBeenCalled()
      expect(current.onBackgroundStreamEvent).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'lets a reattach prove absence once a legacy daemon has exited',
    async () => {
      const current = adapter('current', ['current-session'])
      const exited = adapter('exited')
      vi.mocked(exited.listProcesses).mockRejectedValue(connectError('ECONNREFUSED', 'connect'))
      const router = new DaemonPtyRouter({ current, legacy: [exited] })
      const attach = { cols: 80, rows: 24, sessionId: 'gone-session', attachOnly: true }

      await expect(router.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
      Object.assign(current, {
        spawn: vi.fn(async () => {
          throw new SessionNotFoundError('gone-session')
        })
      })
      await expect(router.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
      expect(current.spawn).toHaveBeenCalledOnce()

      expect(exited.listProcesses).toHaveBeenCalledOnce()
      expect(exited.disconnectOnly).toHaveBeenCalledOnce()
      expect(router.getLegacyAdapters()).toEqual([])
    }
  )

  it('keeps a reattach unverifiable while the legacy socket answers, even with its pid gone', async () => {
    const current = adapter('current')
    const silent = adapter('silent', [], EXITED_PID)
    vi.mocked(silent.listProcesses).mockRejectedValue(new Error('wedged'))
    const router = new DaemonPtyRouter({ current, legacy: [silent] })

    await expect(
      router.spawn({ cols: 80, rows: 24, sessionId: 'session', attachOnly: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(router.getLegacyAdapters()).toEqual([silent])
    expect(silent.disconnectOnly).not.toHaveBeenCalled()
  })

  it('judges a replacement legacy daemon by its own pid, not its predecessor', async () => {
    const current = adapter('current')
    const replaced = adapter('replaced', [], EXITED_PID)
    const router = new DaemonPtyRouter({ current, legacy: [replaced] })
    Object.assign(replaced, {
      getLastAuthenticatedDaemonIdentity: vi.fn(() => ({
        pid: LIVE_PID,
        startedAtMs: 2,
        launchNonce: 'replacement'
      }))
    })
    vi.mocked(replaced.listProcesses).mockRejectedValue(connectError('ECONNREFUSED', 'connect'))

    await expect(
      router.spawn({ cols: 80, rows: 24, sessionId: 'session', attachOnly: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(router.getLegacyAdapters()).toEqual([replaced])
  })

  it('keeps a reattach unverifiable while a gone legacy daemon process is alive', async () => {
    const current = adapter('current')
    const alive = adapter('alive', [], LIVE_PID)
    vi.mocked(alive.listProcesses).mockRejectedValue(connectError('ECONNREFUSED', 'connect'))
    const router = new DaemonPtyRouter({ current, legacy: [alive] })

    await expect(
      router.spawn({ cols: 80, rows: 24, sessionId: 'session', attachOnly: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(router.getLegacyAdapters()).toEqual([alive])
  })

  it('keeps a gone legacy socket whose process is alive or unproven', async () => {
    const current = adapter('current', ['current-session'])
    const alive = adapter('alive', [], LIVE_PID)
    const unknown = adapter('unknown', [], null)
    vi.mocked(alive.listProcesses).mockRejectedValue(connectError('ENOENT', 'connect'))
    vi.mocked(unknown.listProcesses).mockRejectedValue(connectError('ECONNREFUSED', 'connect'))
    const router = new DaemonPtyRouter({ current, legacy: [alive, unknown] })

    await expect(router.listProcesses()).rejects.toThrow('connect')
    expect(router.getLegacyAdapters()).toEqual([alive, unknown])
    expect(alive.disconnectOnly).not.toHaveBeenCalled()
  })

  it('still fails closed for the current daemon and for any other legacy error', async () => {
    const current = adapter('current', ['current-session'])
    const legacy = adapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(new Error('legacy unavailable'))
    await expect(router.listProcesses()).rejects.toThrow('legacy unavailable')
    expect(router.getLegacyAdapters()).toEqual([legacy])

    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(connectError('ENOENT', 'open'))
    await expect(router.listProcesses()).rejects.toThrow('open ENOENT')
    expect(router.getLegacyAdapters()).toEqual([legacy])

    vi.mocked(legacy.listProcesses).mockRejectedValueOnce(connectError('ECONNRESET', 'read'))
    await expect(router.listProcesses()).rejects.toThrow('read ECONNRESET')
    expect(router.getLegacyAdapters()).toEqual([legacy])

    vi.mocked(current.listProcesses).mockRejectedValueOnce(connectError('ECONNREFUSED', 'connect'))
    await expect(router.listProcesses()).rejects.toThrow('connect ECONNREFUSED')
    expect(current.disconnectOnly).not.toHaveBeenCalled()
  })
})
