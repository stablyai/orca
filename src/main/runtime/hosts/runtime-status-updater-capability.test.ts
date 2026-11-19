// @orca-isolated-worker: configureRemoteServerUpdater sets module state the shared-worker reset cannot undo.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { configureRemoteServerUpdater } from './management/remote-server-updater'

describe('runtime status remote update capability', () => {
  it('advertises remote updates only after the host wires an updater', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.getStatus().capabilities).not.toContain('updater.remote-control.v1')

    const snapshot = {
      appVersion: '1.0.0',
      runtimeId: 'runtime-1',
      support: { installMode: 'interactive', automatic: true, reason: 'available' },
      status: { state: 'idle' }
    } as const
    configureRemoteServerUpdater({
      getSnapshot: () => snapshot,
      check: () => snapshot,
      download: () => snapshot,
      install: () => ({
        accepted: true,
        fromVersion: '1.0.0',
        targetVersion: '1.0.1',
        runtimeId: 'runtime-1'
      })
    })
    expect(runtime.getStatus().capabilities).toContain('updater.remote-control.v1')
  })
})
