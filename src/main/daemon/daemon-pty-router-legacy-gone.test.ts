import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'

function adapter(label: string, sessions: string[] = []): DaemonPtyAdapter {
  return {
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    disconnectOnly: vi.fn(async () => {}),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onBackgroundStreamEvent: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

function connectError(code: 'ECONNREFUSED' | 'ENOENT' | 'ECONNRESET', syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

describe('DaemonPtyRouter legacy socket that can never answer', () => {
  it('drops a refused or missing legacy socket and does not ask it again', async () => {
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
