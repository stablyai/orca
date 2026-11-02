import { mkdtempSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/runtime-environment-store-file'
import { getRuntimeEnvironmentSidecarPath } from '../../../shared/runtime-environment-sidecar'
import { pairingCode } from './runtime-environments-ipc-test-harness'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'

// Lets a test make the registry vanish between a presence check and its read.
const fsRace = vi.hoisted(() => {
  const existsAnswers: boolean[] = []
  return { existsAnswers }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    existsSync: (path: fs.PathLike) => fsRace.existsAnswers.shift() ?? actual.existsSync(path)
  }
})

afterEach(() => {
  fsRace.existsAnswers.length = 0
  vi.restoreAllMocks()
})

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

  it('keeps sessions of saved servers this build cannot read or currently hides', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-session-reconcile-hidden-'))
    const linked = addEnvironmentFromPairingCode(userDataPath, {
      name: 'linked',
      pairingCode: pairingCode()
    })
    const path = getEnvironmentStorePath(userDataPath)
    const saved = JSON.parse(fs.readFileSync(path, 'utf8'))
    saved.environments.push({ id: 'env-newer-format', kind: 'future-server' })
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 })
    // An entry this build cannot parse hides its server from listings.
    writeFileSync(
      getRuntimeEnvironmentSidecarPath(userDataPath),
      JSON.stringify({ version: 1, entries: { [linked.id]: { futureLinkField: true } } }),
      { mode: 0o600 }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = sessionStore([
      `runtime:${linked.id}`,
      'runtime:env-newer-format',
      'runtime:removed-env'
    ])

    expect(reconcileOrphanedRuntimeSessions(store, userDataPath)).toEqual(['runtime:removed-env'])
    expect(store.removeWorkspaceSessionHost).toHaveBeenCalledTimes(1)
  })

  it('deletes nothing when the registry disappears between its presence check and read', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-session-reconcile-race-'))
    const store = sessionStore(['runtime:env-1'])
    // Present when first checked, gone by the time the read looks again.
    fsRace.existsAnswers.push(true, false)

    expect(reconcileOrphanedRuntimeSessions(store, userDataPath)).toEqual([])
    expect(store.removeWorkspaceSessionHost).not.toHaveBeenCalled()
  })
})
