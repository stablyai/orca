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
  it('keeps each pane its last folder in the Linux form the host opens', async () => {
    const answers: Record<string, ColdRestoreDetection> = {
      'wt@@a': restored('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\src'),
      'wt@@b': restored('/home/dev/app/test'),
      'wt@@c': restored('\\\\wsl.localhost\\Debian\\home\\dev'),
      'wt@@d': restored('C:\\Users\\dev'),
      'wt@@e': { status: 'none' },
      'wt@@f': { status: 'unreadable', sessionId: 'wt@@f' },
      'wt@@g': restored('\\\\wsl$\\ubuntu\\home\\dev\\app\\docs'),
      'wt@@h': restored('//wsl.localhost/Ubuntu/home/dev/app/bin', true)
    }
    const seen: unknown[] = []
    const capture = await captureWslMoveRestoreHints(
      {
        detectColdRestoreState: async (sessionId, opts) => {
          seen.push(opts)
          return answers[sessionId] ?? { status: 'none' }
        }
      },
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((leaf) => ({
        paneKey: `t:${leaf}`,
        sessionId: `wt@@${leaf}`,
        wslDistro: 'ubuntu'
      })),
      'Ubuntu'
    )
    expect(capture).toEqual({
      hints: [
        { paneKey: 't:a', cwd: '/home/dev/app/src' },
        { paneKey: 't:b', cwd: '/home/dev/app/test' },
        { paneKey: 't:g', cwd: '/home/dev/app/docs' },
        { paneKey: 't:h', cwd: '/home/dev/app/bin' }
      ],
      unreadablePaneKeys: ['t:f'],
      noCwdPaneKeys: ['t:c', 't:d', 't:e'],
      staleCwdPaneKeys: ['t:h']
    })
    // A sleep ends sessions cleanly; the read must not skip them for it.
    expect(seen[0]).toEqual({ ignoreCleanEnd: true, wslDistro: 'Ubuntu' })
  })

  it('reports panes without a usable folder instead of skipping them', async () => {
    const answers: Record<string, ColdRestoreDetection> = {
      'wt@@none': { status: 'none' },
      'wt@@debian': restored('\\\\wsl.localhost\\Debian\\home\\dev'),
      'wt@@gitbash': restored('/c/src/app'),
      'wt@@unknown': restored('/home/dev/app')
    }
    const capture = await captureWslMoveRestoreHints(
      { detectColdRestoreState: async (sessionId) => answers[sessionId] ?? { status: 'none' } },
      [
        { paneKey: 't:none', sessionId: 'wt@@none', wslDistro: 'Ubuntu' },
        { paneKey: 't:debian', sessionId: 'wt@@debian', wslDistro: 'Ubuntu' },
        // A native Git Bash pane's POSIX folder is not a Linux path in the distro.
        { paneKey: 't:gitbash', sessionId: 'wt@@gitbash', wslDistro: null },
        { paneKey: 't:unknown', sessionId: 'wt@@unknown' }
      ],
      'Ubuntu'
    )
    expect(capture.hints).toEqual([])
    expect(capture.noCwdPaneKeys).toEqual(['t:none', 't:debian', 't:gitbash', 't:unknown'])
  })

  it('names a pane whose read throws as unreadable and reads the rest', async () => {
    const capture = await captureWslMoveRestoreHints(
      {
        detectColdRestoreState: async (sessionId) => {
          if (sessionId === 'wt@@bad') {
            throw new Error('EIO')
          }
          return restored('/home/dev/app')
        }
      },
      [
        { paneKey: 't:bad', sessionId: 'wt@@bad', wslDistro: 'Ubuntu' },
        { paneKey: 't:ok', sessionId: 'wt@@ok', wslDistro: 'Ubuntu' }
      ],
      'Ubuntu'
    )
    expect(capture.unreadablePaneKeys).toEqual(['t:bad'])
    expect(capture.hints).toEqual([{ paneKey: 't:ok', cwd: '/home/dev/app' }])
  })

  it('flags a folder that is only where the session started as stale', async () => {
    const capture = await captureWslMoveRestoreHints(
      { detectColdRestoreState: async () => restored('/home/dev/app', false, true) },
      [{ paneKey: 't:a', sessionId: 'wt@@a', wslDistro: 'Ubuntu' }],
      'Ubuntu'
    )
    expect(capture.hints).toEqual([{ paneKey: 't:a', cwd: '/home/dev/app' }])
    expect(capture.staleCwdPaneKeys).toEqual(['t:a'])
  })
})
