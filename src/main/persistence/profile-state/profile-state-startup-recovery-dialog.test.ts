import { describe, expect, it, vi } from 'vitest'
import { presentProfileStateStartupRecoveryDialog } from './profile-state-startup-recovery-dialog'

describe('profile state startup recovery dialog', () => {
  it('offers a copyable offline export command and does not mutate state', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'SQLite state is unreadable.\nSQLite path: /tmp/profile-state.db',
      recoveryCommand: 'orca profile state exports',
      showMessageBox,
      copyToClipboard
    })

    expect(showMessageBox).toHaveBeenCalledWith({
      type: 'error',
      buttons: ['Copy recovery command', 'Quit'],
      defaultId: 1,
      cancelId: 1,
      title: 'Orca profile state cannot be opened',
      message: 'Orca cannot safely open this profile.',
      detail:
        'SQLite state is unreadable.\nSQLite path: /tmp/profile-state.db\n\nCopy the recovery command, then run it after Orca closes.'
    })
    expect(copyToClipboard).toHaveBeenCalledWith('orca profile state exports')
  })

  it('leaves the clipboard untouched when the user quits', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'ambiguous profile state',
      recoveryCommand: 'orca profile state exports',
      showMessageBox,
      copyToClipboard
    })

    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('does not offer rollback for an authority ambiguity', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'both profile authorities are present',
      showMessageBox,
      copyToClipboard
    })

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Quit'],
        defaultId: 0,
        cancelId: 0,
        detail:
          'both profile authorities are present\n\nQuit Orca and resolve the profile-state authority before retrying.'
      })
    )
    expect(copyToClipboard).not.toHaveBeenCalled()
  })
})
