import { describe, expect, it, vi } from 'vitest'
import {
  checkRemoteServerUpdater,
  configureRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater
} from './remote-server-updater'

describe('remote server updater adapter', () => {
  it('defaults to a safe manual-only implementation', () => {
    expect(getRemoteServerUpdaterSnapshot('runtime-1')).toMatchObject({
      runtimeId: 'runtime-1',
      support: { automatic: false, reason: 'updater-unavailable' }
    })
    expect(() => checkRemoteServerUpdater('runtime-1')).toThrow('remote_update_manual_required')
    expect(() => downloadRemoteServerUpdater('runtime-1')).toThrow('remote_update_manual_required')
    expect(() => installRemoteServerUpdater('runtime-1')).toThrow('remote_update_manual_required')
  })

  it('passes the runtime identity through every configured operation', () => {
    const snapshot = {
      appVersion: '1.5.0',
      runtimeId: 'runtime-2',
      support: { installMode: 'interactive', automatic: true, reason: 'available' },
      status: { state: 'available', version: '1.5.1', changelog: null }
    } as const
    const getSnapshot = vi.fn(() => snapshot)
    const check = vi.fn(() => snapshot)
    const download = vi.fn(() => snapshot)
    const install = vi.fn(() => ({
      accepted: true as const,
      fromVersion: '1.5.0',
      targetVersion: '1.5.1',
      runtimeId: 'runtime-2'
    }))
    configureRemoteServerUpdater({ getSnapshot, check, download, install })

    expect(getRemoteServerUpdaterSnapshot('runtime-2')).toBe(snapshot)
    expect(checkRemoteServerUpdater('runtime-2')).toBe(snapshot)
    expect(downloadRemoteServerUpdater('runtime-2')).toBe(snapshot)
    expect(installRemoteServerUpdater('runtime-2').accepted).toBe(true)
    expect([getSnapshot, check, download, install].map((fn) => fn.mock.calls[0])).toEqual([
      ['runtime-2'],
      ['runtime-2'],
      ['runtime-2'],
      ['runtime-2']
    ])
  })
})
