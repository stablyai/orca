import { describe, expect, it } from 'vitest'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'
import { ProfileStateWriterReopenPolicy } from './profile-state-writer-reopen-policy'

function policyWithSpaceCheck(check: () => Promise<boolean | undefined>) {
  const notices: ProfileStateSaveNotice[] = []
  let checks = 0
  const policy = new ProfileStateWriterReopenPolicy(
    () => ({ onSaveDelayChanged: (notice) => notices.push(notice) }),
    Date.now,
    () => {
      checks += 1
      return check()
    }
  )
  policy.useStorageDirectory('/profile')
  return { policy, notices, checks: () => checks }
}

const interruptedWrite = (): Error => new Error('disk I/O error')

describe('profile save notice for an interrupted write with no disk-full error code', () => {
  it('says the disk is full only when the free-space check confirms it, once per failure streak', async () => {
    const full = policyWithSpaceCheck(async () => true)
    full.policy.recoverFrom(interruptedWrite())
    full.policy.recoverFrom(interruptedWrite())
    await Promise.resolve()
    expect(full.notices).toEqual(['failing', 'disk-full'])
    expect(full.checks()).toBe(1)
    full.policy.recordSaved()
    expect(full.notices).toEqual(['failing', 'disk-full', null])

    const unknown = policyWithSpaceCheck(() => Promise.reject(new Error('statfs failed')))
    unknown.policy.recoverFrom(interruptedWrite())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unknown.notices).toEqual(['failing'])
  })
})
