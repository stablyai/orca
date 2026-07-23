import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getHistorySessionDirName } from './history-paths'
import { HistoryManager } from './history-manager'
import type { TerminalSnapshot } from './types'

const directories: string[] = []

function createManager(): { directory: string; manager: HistoryManager } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-history-manager-memory-'))
  directories.push(directory)
  return { directory, manager: new HistoryManager(directory) }
}

function snapshot(snapshotAnsi: string): TerminalSnapshot {
  return {
    snapshotAnsi,
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    scrollbackLines: 0
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('terminal history write memory limits', () => {
  it('rejects an oversized escaped checkpoint before writing it', async () => {
    const { directory, manager } = createManager()
    await manager.openSession('checkpoint', { cwd: '/workspace', cols: 80, rows: 24 })

    await manager.checkpoint('checkpoint', snapshot('\n'.repeat(9 * 1024 * 1024)))

    expect(manager.isSessionDisabled('checkpoint')).toBe(true)
    expect(
      existsSync(join(directory, getHistorySessionDirName('checkpoint'), 'checkpoint.json'))
    ).toBe(false)
  })

  it('rejects oversized escaped metadata before writing it', async () => {
    const { directory, manager } = createManager()

    await manager.openSession('metadata', {
      cwd: '\n'.repeat(40 * 1024),
      cols: 80,
      rows: 24
    })

    expect(manager.isSessionDisabled('metadata')).toBe(true)
    expect(existsSync(join(directory, getHistorySessionDirName('metadata'), 'meta.json'))).toBe(
      false
    )
  })
})
