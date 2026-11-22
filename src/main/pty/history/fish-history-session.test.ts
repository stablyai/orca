import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteFishHistoryFile,
  fishHistorySessionName,
  relayFishHistorySessionName,
  sweepOrphanedFishHistoryFiles
} from './fish-history-session'

const HASH_A = 'a1b2c3d4e5f60718'
const HASH_B = '00112233445566ff'
const SESSION_A = fishHistorySessionName(HASH_A)

describe('fish history cleanup', () => {
  let root: string
  let fishDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-history-'))
    fishDir = join(root, 'fish')
    mkdirSync(fishDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const historyFile = (session: string): string => join(fishDir, `${session}_history`)

  // Windows symlinks require Developer Mode or elevation.
  it.skipIf(process.platform === 'win32')(
    'refuses to follow a symlink out of the fish data dir',
    () => {
      const outside = join(root, 'precious.txt')
      writeFileSync(outside, 'keep me\n')
      symlinkSync(outside, historyFile(SESSION_A))

      expect(deleteFishHistoryFile(SESSION_A, [fishDir])).toBe(false)
      expect(existsSync(outside)).toBe(true)
    }
  )

  it('removes dead desktop history while keeping live desktop and relay history', () => {
    const live = historyFile(fishHistorySessionName(HASH_A))
    const dead = historyFile(fishHistorySessionName(HASH_B))
    const relay = historyFile(relayFishHistorySessionName(HASH_B))
    writeFileSync(live, 'live\n')
    writeFileSync(dead, 'dead\n')
    writeFileSync(relay, 'relay\n')

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir])).toBe(1)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(relay)).toBe(true)
  })
})
