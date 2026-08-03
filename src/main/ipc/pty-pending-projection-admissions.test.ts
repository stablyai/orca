import { describe, expect, it, vi } from 'vitest'
import {
  appendPendingProjectionAdmission,
  compactPendingProjectionAdmissions,
  PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS,
  propagatePendingProjectionRemainder
} from './pty-pending-projection-admissions'

describe('pending PTY projection admissions', () => {
  it('retains the exact cap then transfers the whole ordered run on overflow', () => {
    const transfer = vi.fn()
    let state = compactPendingProjectionAdmissions()

    for (let index = 0; index < PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS; index++) {
      state = appendPendingProjectionAdmission(state, `projection-${index}`, {
        isPending: () => true,
        transfer
      })
    }

    expect(state.projectionAdmissionIds).toHaveLength(PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS)
    expect(transfer).not.toHaveBeenCalled()

    state = appendPendingProjectionAdmission(state, 'projection-overflow', {
      isPending: () => true,
      transfer
    })

    expect(state).toEqual({ projectionAdmissionsTransferred: true })
    expect(transfer).toHaveBeenCalledOnce()
    expect(transfer.mock.calls[0]?.[0]).toHaveLength(PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS + 1)
  })

  it('compacts terminal prefixes and transfers later admissions until the remainder drains', () => {
    const transfer = vi.fn()
    const compacted = propagatePendingProjectionRemainder(
      {
        projectionAdmissionIds: ['projection-published', 'projection-partial', 'projection-tail']
      },
      { sent: true, projectionsTransferred: false },
      { isPending: (id) => id !== 'projection-published', transfer }
    )

    expect(compacted).toEqual({
      projectionAdmissionIds: ['projection-partial', 'projection-tail']
    })

    const transferred = appendPendingProjectionAdmission(
      { projectionAdmissionsTransferred: true },
      'projection-after-transfer',
      { isPending: () => true, transfer }
    )
    expect(transferred).toEqual({ projectionAdmissionsTransferred: true })
    expect(transfer).toHaveBeenCalledWith(['projection-after-transfer'], 'pending-projection-cap')

    expect(
      propagatePendingProjectionRemainder(
        compacted,
        { sent: true, projectionsTransferred: true },
        { isPending: () => true, transfer }
      )
    ).toEqual({ projectionAdmissionsTransferred: true })
  })
})
