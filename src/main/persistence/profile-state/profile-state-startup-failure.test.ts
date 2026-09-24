import { describe, expect, it } from 'vitest'
import {
  ProfileStateAuthorityBootstrapError,
  ProfileStateRecoveryRequiredError
} from './profile-state-authority-bootstrap'
import {
  formatProfileStateStartupFailure,
  profileStateStartupFailureClass
} from './profile-state-startup-failure'
import { ProfileStateWriterError } from './profile-state-writer-errors'
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'

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

  it('reports a missing writer without exposing its cause or suggesting database rollback', () => {
    const error = new ProfileStateWriterError(
      'profile-state-writer-unavailable',
      'Profile state writer could not start',
      'known-failure',
      { cause: new Error('private runtime path') }
    )
    expect(profileStateStartupFailureClass(error)).toBe('writer-unavailable')
    expect(formatProfileStateStartupFailure(error)).toBe(
      'Orca could not start profile persistence. Restart Orca; if the problem continues, repair or reinstall this build.'
    )
  })

  it('reports an admission race as a conflicting writer', () => {
    const error = new ProfileStateRevisionConflictError(2, 3)
    expect(profileStateStartupFailureClass(error)).toBe('revision-conflict')
    expect(formatProfileStateStartupFailure(error)).toContain('Close other Orca processes')
  })
})
