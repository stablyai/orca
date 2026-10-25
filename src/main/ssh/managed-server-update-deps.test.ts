import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { managedServerUpdateDeps } from './managed-server-update-deps'
import { checkManagedServerUpdate } from './managed-server-update-check'

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))

const stored = new Map<string, SshTarget>()
// Model store copies so writes must be re-read instead of mutating caller snapshots.
vi.mock('../managed-server/lifecycle/orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({
    getTarget: (id: string) => {
      const entry = stored.get(id)
      return entry ? { ...entry } : undefined
    },
    updateTarget: (id: string, updates: Partial<SshTarget>) => {
      const entry = stored.get(id)
      if (entry) {
        stored.set(id, { ...entry, ...updates })
      }
      return entry ?? null
    }
  })
}))
vi.mock('../managed-server/lifecycle/orcad-managed-auto-update', () => ({
  autoUpdateManagedOrcadEnvironment: vi.fn()
}))

const target = (id: string): SshTarget => ({ id, label: id, host: id, port: 22, username: 'me' })

describe('remembering a managed-server update failure for this launch', () => {
  it('counts only an actual failure, and outlives the per-connect deps', () => {
    stored.set('a', target('a'))
    const deps = managedServerUpdateDeps('/tmp/user-data')
    expect(deps.failedThisLaunch(target('a'))).toBe(false)
    deps.recordUpdateFailure(target('a'), 'candidate rejected')
    expect(managedServerUpdateDeps('/tmp/user-data').failedThisLaunch(target('a'))).toBe(true)
    expect(deps.failedThisLaunch(target('b'))).toBe(false)
  })

  it('an overlapping check sees the failure the first one recorded on a copy it took earlier', async () => {
    stored.set('c', target('c'))
    // Both caller snapshots predate either check, as connect and tunnel restore can.
    const first = { ...stored.get('c')! }
    const second = { ...stored.get('c')! }
    const deps = managedServerUpdateDeps('/tmp/user-data')
    let tries = 0
    let lock = Promise.resolve()
    const autoUpdate: typeof deps.autoUpdate = (_environmentId, options) => {
      const run = lock.then(() => {
        if (options.failedBefore()) {
          return { outcome: 'skipped' as const, reason: 'failed-before' as const }
        }
        tries += 1
        return { outcome: 'failed' as const, reason: 'bad' }
      })
      lock = run.then(() => undefined)
      return run
    }
    const withLock = { ...deps, autoUpdate }

    const results = await Promise.all([
      checkManagedServerUpdate(first, 'env-c', withLock, () => {}),
      checkManagedServerUpdate(second, 'env-c', withLock, () => {})
    ])

    expect(tries).toBe(1)
    expect(results[1].note).toEqual({ state: 'failed', detail: 'bad' })
  })
})
