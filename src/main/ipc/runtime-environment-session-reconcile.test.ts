import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../shared/runtime-environment-store-file'
import { pairingCode } from './runtime-environments-ipc-test-harness'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'

function sessionStore(hostIds: ExecutionHostId[]) {
  return {
    getWorkspaceSessionHostIds: () => hostIds,
    removeWorkspaceSessionHost: vi.fn()
  }
}

describe('reconciling orphaned runtime sessions at startup', () => {
  it('drops only runtime sessions whose server is gone, never local or ssh', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-session-reconcile-'))
    const kept = addEnvironmentFromPairingCode(userDataPath, {
      name: 'kept',
      pairingCode: pairingCode()
    })
    const store = sessionStore([
      'local',
      'ssh:target-1',
      `runtime:${kept.id}`,
      'runtime:removed-env'
    ])
    expect(reconcileOrphanedRuntimeSessions(store, userDataPath)).toEqual(['runtime:removed-env'])
    expect(store.removeWorkspaceSessionHost).toHaveBeenCalledTimes(1)
    expect(store.removeWorkspaceSessionHost).toHaveBeenCalledWith('runtime:removed-env')
  })

  it('deletes nothing when the environment store is missing or unreadable', () => {
    const missing = mkdtempSync(join(tmpdir(), 'orca-session-reconcile-missing-'))
    const store = sessionStore(['runtime:removed-env'])
    expect(reconcileOrphanedRuntimeSessions(store, missing)).toEqual([])

    const corrupt = mkdtempSync(join(tmpdir(), 'orca-session-reconcile-corrupt-'))
    writeFileSync(getEnvironmentStorePath(corrupt), '{not json', { mode: 0o600 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(reconcileOrphanedRuntimeSessions(store, corrupt)).toEqual([])
    expect(store.removeWorkspaceSessionHost).not.toHaveBeenCalled()
  })
})
