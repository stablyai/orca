import { describe, expect, it } from 'vitest'
import {
  createMobileSessionCreateWarningState,
  dismissMobileSessionCreateWarningState,
  reconcileMobileSessionCreateWarningState
} from './mobile-session-create-warning-state'

describe('mobile session create warning state', () => {
  it('preserves a dismissed warning while the route warning is unchanged', () => {
    const dismissed = dismissMobileSessionCreateWarningState(
      createMobileSessionCreateWarningState('Created, but setup failed')
    )

    expect(reconcileMobileSessionCreateWarningState(dismissed, 'Created, but setup failed')).toBe(
      dismissed
    )
  })

  it('shows a new warning when the route warning changes', () => {
    const dismissed = dismissMobileSessionCreateWarningState(
      createMobileSessionCreateWarningState('Old warning')
    )

    expect(reconcileMobileSessionCreateWarningState(dismissed, 'New warning')).toEqual({
      source: 'New warning',
      visible: 'New warning'
    })
  })
})
