import { describe, expect, it } from 'vitest'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'
import { ProfileStateIndeterminateWriteError } from '../database/profile-state-write-transaction'
import { storageCapacityErrorCode } from '../../../../shared/errors/storage-capacity-error'
import {
  decodeProfileStateWriterError,
  encodeProfileStateWriterError
} from './profile-state-writer-errors'
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

  it('reports a stopped writer once until a save lands again', () => {
    const failures: unknown[] = []
    const policy = new ProfileStateWriterReopenPolicy(() => ({
      onFailure: (error) => failures.push(error)
    }))
    const conflict = new Error('profile-state-revision-conflict')
    policy.reportStopped(conflict)
    policy.reportStopped(conflict)
    policy.recordSaved()
    policy.reportStopped(conflict)
    expect(failures).toHaveLength(2)
  })

  it('warns when a save, but not an export, finds the writer unable to reopen', () => {
    const notices: ProfileStateSaveNotice[] = []
    const policy = new ProfileStateWriterReopenPolicy(() => ({
      onSaveDelayChanged: (notice) => notices.push(notice)
    }))
    policy.recordReopenRefused(new Error('database is locked'), false)
    expect(notices).toEqual([])
    policy.recordReopenRefused(new Error('database is locked'), true)
    expect(notices).toEqual(['failing'])
  })

  it('keeps a full-disk cause across the worker boundary for an interrupted write', () => {
    const full = Object.assign(new Error('database or disk is full'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 13
    })
    const interrupted = new ProfileStateIndeterminateWriteError(full, new Error('rollback failed'))
    const decoded = decodeProfileStateWriterError(encodeProfileStateWriterError(interrupted))
    expect(storageCapacityErrorCode(decoded)).toBe('SQLITE_FULL')
  })

  it("ignores a retired writer's late slow signal", async () => {
    const notices: ProfileStateSaveNotice[] = []
    const policy = new ProfileStateWriterReopenPolicy(() => ({
      onSaveDelayChanged: (notice) => notices.push(notice)
    }))
    const retired = policy.beginWriter()
    const current = policy.beginWriter()
    policy.writerDelayChanged(true, current)
    policy.writerDelayChanged(false, retired)
    await Promise.resolve()
    expect(notices).toEqual(['slow'])
  })
})
