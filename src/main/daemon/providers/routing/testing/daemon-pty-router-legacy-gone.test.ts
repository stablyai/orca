import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import { DaemonPtyRouter } from '../daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'

const LIVE_PID = 4242
const EXITED_PID = 4343

vi.mock('../../../endpoint/identity/daemon-process-inspection', () => ({
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
})
