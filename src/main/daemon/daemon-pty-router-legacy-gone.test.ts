import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'

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
  // Windows keeps failing closed: the router never treats a missing pid as proof there.
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
