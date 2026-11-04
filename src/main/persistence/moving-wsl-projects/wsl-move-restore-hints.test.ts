import { describe, expect, it } from 'vitest'
import type { ColdRestoreDetection } from '../../daemon/history-reader'
import { captureWslMoveRestoreHints } from './wsl-move-restore-hints'

const restored = (
  cwd: string,
  hasUnreadableRecovery = false,
  cwdFromSpawn = false
): ColdRestoreDetection => ({
  status: 'restored',
  sessionId: 's',
  hasUnreadableRecovery,
  ...(cwdFromSpawn ? { cwdFromSpawn: true as const } : {}),
  restoreInfo: {
    snapshotAnsi: '',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd,
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
  }
})

describe('captureWslMoveRestoreHints', () => {
  // Bash on the bridge reports no folder, so an open pane's checkpoint kept its
  // spawn folder and `cd deep/er` reopened at the project root.
  it('prefers the folder the shell was in before Sleep over the spawn folder', async () => {
    const capture = await captureWslMoveRestoreHints(
      {
        detectColdRestoreState: async () =>
          restored('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', false, true)
      },
      [{ paneKey: 't:a', sessionId: 'wt@@a', shellCwd: '/home/dev/app/deep/er' }],
      'Ubuntu'
    )
    expect(capture.hints).toEqual([{ paneKey: 't:a', cwd: '/home/dev/app/deep/er' }])
    expect(capture.staleCwdPaneKeys).toEqual([])
  })
})
