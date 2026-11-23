import { describe, expect, it } from 'vitest'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'
import { ProfileStateWriterReopenPolicy } from './profile-state-writer-reopen-policy'

describe('profile save notice', () => {
  it('says the disk is full only for a failure whose own error reports full storage', () => {
    const notices: ProfileStateSaveNotice[] = []
    const policy = new ProfileStateWriterReopenPolicy(() => ({
      onSaveDelayChanged: (notice) => notices.push(notice)
    }))
    const diskFull = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
    policy.recordSaveRefused(diskFull)
    policy.recordSaveRefused(new Error('database is locked'))
    policy.recoverFrom(new Error('disk I/O error'))
    policy.recordSaved()
    expect(notices).toEqual(['disk-full', 'failing', null])
  })
})
