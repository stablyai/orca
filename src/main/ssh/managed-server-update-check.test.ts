import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from './managed-server-update-check'
import type { ManagedOrcadAutoUpdateOutcome } from '../managed-server/lifecycle/orcad-managed-auto-update'
import { ORCAD_ACTIVATION_FENCE_BUSY_CODE } from '../managed-server/activation/orcad-activation-fence-hold'

// The retry decision is read under the host's lifecycle lock, so the stub's last call answers it.
const failedBeforeOf = (autoUpdate: ManagedServerUpdateDeps['autoUpdate']) =>
  vi.mocked(autoUpdate).mock.lastCall?.[1].failedBefore()

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function deps(
  outcome: ManagedOrcadAutoUpdateOutcome | Error,
  overrides: Partial<ManagedServerUpdateDeps> = {}
): ManagedServerUpdateDeps {
  return {
    autoUpdate: vi.fn(async () => {
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }),
    recordedUpdateFailure: () => null,
    failedThisLaunch: () => true,
    recordUpdateFailure: vi.fn(),
    clearUpdateFailure: vi.fn(),
    ...overrides
  }
}

const check = (d: ManagedServerUpdateDeps) => checkManagedServerUpdate(target, 'env-1', d, vi.fn())

describe('checkManagedServerUpdate notes a server that may be behind this app', () => {
  it.each<[string, ManagedOrcadAutoUpdateOutcome | Error, unknown]>([
    ['rolled back', { outcome: 'skipped', reason: 'rolled-back' }, { state: 'rolled-back' }],
    ['no bundled build', { outcome: 'skipped', reason: 'no-template' }, { state: 'no-template' }],
    ['mid-migration', { outcome: 'skipped', reason: 'migrating' }, { state: 'migrating' }],
    ['check threw', new Error('ssh dropped'), { state: 'check-failed', detail: 'ssh dropped' }],
    ['failed', { outcome: 'failed', reason: 'bad' }, { state: 'failed', detail: 'bad' }],
    [
      'fence busy',
      { outcome: 'deferred', code: ORCAD_ACTIVATION_FENCE_BUSY_CODE, reason: 'held' },
      { state: 'deferred', detail: 'held' }
    ],
    ['host newer', { outcome: 'skipped', reason: 'host-newer' }, { state: 'host-newer' }]
  ])('%s', async (_name, outcome, note) => {
    expect((await check(deps(outcome))).note).toEqual(note)
  })

  it('names the recorded failure when it is not retried', async () => {
    const result = await check(
      deps({ outcome: 'skipped', reason: 'failed-before' }, { recordedUpdateFailure: () => 'old' })
    )
    expect(result.note).toEqual({ state: 'failed', detail: 'old' })
  })

  it('stays quiet when the server is current or updated', async () => {
    expect((await check(deps({ outcome: 'skipped', reason: 'current' }))).note).toBeUndefined()
    expect((await check(deps({ outcome: 'updated', activeVersion: '1' }))).note).toBeUndefined()
  })
})

describe('a recorded update failure', () => {
  it('is retried when the launch allows it, and skipped otherwise', async () => {
    const retried = deps(
      { outcome: 'updated', activeVersion: '1' },
      { recordedUpdateFailure: () => 'old', failedThisLaunch: () => false }
    )
    await check(retried)
    expect(failedBeforeOf(retried.autoUpdate)).toBe(false)
    expect(retried.clearUpdateFailure).toHaveBeenCalledWith(target)

    const held = deps(
      { outcome: 'skipped', reason: 'failed-before' },
      { recordedUpdateFailure: () => 'old' }
    )
    await check(held)
    expect(failedBeforeOf(held.autoUpdate)).toBe(true)
  })

  it.each([
    ['a failure recorded by an earlier launch', 'old'],
    ['no recorded failure', null]
  ])('with %s, lets only one of two overlapping checks try the update', async (_name, recorded) => {
    const failedThisLaunch = new Set<string>()
    let failure: string | null = recorded
    let lock: Promise<unknown> = Promise.resolve()
    let attempts = 0
    const d = deps(
      { outcome: 'failed', reason: 'bad' },
      {
        recordedUpdateFailure: () => failure,
        failedThisLaunch: (t) => failedThisLaunch.has(t.id),
        recordUpdateFailure: (t, reason) => {
          failure = reason
          failedThisLaunch.add(t.id)
        },
        // Like the host lifecycle lock: one update at a time, each reading the decision inside.
        autoUpdate: (_id, options) => {
          const run = lock.then(async (): Promise<ManagedOrcadAutoUpdateOutcome> => {
            if (options.failedBefore()) {
              return { outcome: 'skipped', reason: 'failed-before' }
            }
            attempts += 1
            return { outcome: 'failed', reason: 'bad' }
          })
          lock = run
          return run
        }
      }
    )
    const results = await Promise.all([check(d), check(d)])
    expect(attempts).toBe(1)
    // The waiting check names the failure the first one just recorded.
    expect(results[1].note).toEqual({ state: 'failed', detail: 'bad' })
  })
})
