import { describe, expect, it } from 'vitest'
import {
  ProfileStateAuthorityBootstrapError,
  ProfileStateRecoveryRequiredError
} from './profile-state-authority-bootstrap'
import {
  formatProfileStateStartupFailure,
  profileStateStartupFailureClass
} from './profile-state-startup-failure'

describe('profile-state startup failure formatting', () => {
  it('prints recovery paths and the offline rollback command', () => {
    const error = new ProfileStateRecoveryRequiredError(
      {
        dataFile: '/profile/orca-data.json',
        databaseFile: '/profile/profile-state.db',
        profileId: 'profile-a'
      },
      new Error('database is corrupt')
    )

    expect(formatProfileStateStartupFailure(error)).toContain(
      'orca profile state rollback --revision <revision>'
    )
    expect(formatProfileStateStartupFailure(error)).toContain('/profile/profile-state.db')
    expect(profileStateStartupFailureClass(error)).toBe('recovery-required')
  })

  it('formats authority ambiguity without suggesting a destructive recovery', () => {
    const message = formatProfileStateStartupFailure(
      new ProfileStateAuthorityBootstrapError('both profile stores are present')
    )

    expect(message).toBe(
      'Orca cannot safely choose a profile-state authority: both profile stores are present'
    )
    expect(
      profileStateStartupFailureClass(new ProfileStateAuthorityBootstrapError('ambiguous'))
    ).toBe('ambiguous-authority')
  })

  it('shows retained SQLite backups and their explicit recovery command without JSON exports', () => {
    const message = formatProfileStateStartupFailure({
      code: 'profile-state-recovery-required',
      dataFile: '/profile/orca-data.json',
      databaseFile: '/profile/profile-state.db',
      exportPaths: [],
      backupPaths: ['/profile/profile-state.db.backup.latest.db']
    })
    expect(message).toContain(
      'Retained SQLite backups:\n  /profile/profile-state.db.backup.latest.db'
    )
    expect(message).toContain('orca profile state rollback --backup <id>')
  })

  it('leaves unrelated startup errors on the existing fatal path', () => {
    expect(formatProfileStateStartupFailure(new Error('unrelated startup failure'))).toBeUndefined()
    expect(profileStateStartupFailureClass(new Error('unrelated startup failure'))).toBeUndefined()
  })
})
