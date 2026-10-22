import { describe, expect, it, vi } from 'vitest'
import {
  chooseProfileStateCopy,
  chooseProfileStateRepair,
  presentProfileStateStartupRecoveryDialog
} from './profile-state-startup-recovery-dialog'

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

  it.each([
    [0, 'current-sqlite'],
    [1, 'current-json'],
    [2, undefined]
  ] as const)('maps choice button %i to %s', async (response, expected) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response })
    await expect(
      chooseProfileStateCopy({
        sqliteSavedAt: new Date(1),
        jsonSavedAt: new Date(2),
        formatTime: (time) => `t${time.getTime()}`,
        showMessageBox
      })
    ).resolves.toBe(expected)
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Use SQLite (Recommended)', 'Use JSON', 'Quit'],
        defaultId: 0,
        cancelId: 2
      })
    )
    const { detail } = showMessageBox.mock.calls[0][0]
    expect(detail).toContain('Last saved t1.')
    expect(detail).toContain('Last saved t2.')
  })

  it('omits save times it could not read', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 2 })
    await chooseProfileStateCopy({ showMessageBox })
    expect(showMessageBox.mock.calls[0][0].detail).not.toContain('Last saved')
  })

  it.each([
    { response: 0, repair: true },
    { response: 1, repair: false }
  ])(
    'asks before repairing damaged sections (response $response)',
    async ({ response, repair }) => {
      const showMessageBox = vi.fn().mockResolvedValue({ response })
      await expect(
        chooseProfileStateRepair({
          sections: [
            { domain: 'repos', backupId: '1-a', backupCreatedAtMs: 5 },
            { domain: 'settings', backupId: null }
          ],
          formatTime: (time) => `t${time.getTime()}`,
          showMessageBox
        })
      ).resolves.toBe(repair)
      expect(showMessageBox).toHaveBeenCalledWith({
        type: 'warning',
        buttons: ['Repair and Restart', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'Repair profile',
        message: "Part of this profile's saved state is damaged.",
        detail: [
          'Projects: restored from the backup saved t5.',
          'Settings: no readable backup, so it will start empty.',
          '',
          'Everything else stays as it is now.',
          '',
          'Projects added after that backup will be removed from Orca, along with their workspace details. Files on disk are not touched.',
          '',
          'Orca keeps a copy of the damaged file in its data folder, then restarts.'
        ].join('\n')
      })
    }
  )
})
