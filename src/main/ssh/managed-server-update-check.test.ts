import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from './managed-server-update-check'
import type { ManagedOrcadAutoUpdateOutcome } from '../managed-server/lifecycle/orcad-managed-auto-update'

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

describe('a recorded update failure', () => {
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
        // Serialize like the host lifecycle lock, reading each decision after the preceding update.
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
    // The waiting check must observe the newly recorded failure.
    expect(results[1].note).toEqual({ state: 'failed', detail: 'bad' })
  })
})
