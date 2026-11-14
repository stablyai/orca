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

describe('fish history deletion', () => {
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
})

describe('orphaned fish history sweep', () => {
  let root: string
  let fishDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-sweep-'))
    fishDir = join(root, 'fish')
    mkdirSync(fishDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('removes files for dead worktrees and keeps live ones', () => {
    writeFileSync(join(fishDir, `${fishHistorySessionName(HASH_A)}_history`), 'live\n')
    writeFileSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`), 'dead\n')

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir])).toBe(1)
    expect(existsSync(join(fishDir, `${fishHistorySessionName(HASH_A)}_history`))).toBe(true)
    expect(existsSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`))).toBe(false)
  })
})

// Desktop live sets cannot account for remote clients’ history; prefixes keep their sweeps separate.
describe('relay fish history naming', () => {
  let relayRoot: string

  beforeEach(() => {
    relayRoot = mkdtempSync(join(tmpdir(), 'orca-fish-relay-'))
  })

  afterEach(() => {
    rmSync(relayRoot, { recursive: true, force: true })
  })

  it('survives a desktop sweep that knows none of the relay worktree ids', () => {
    const dir = relayRoot
    const relayFile = join(dir, `${relayFishHistorySessionName(HASH_A)}_history`)
    const desktopFile = join(dir, `${fishHistorySessionName(HASH_B)}_history`)
    writeFileSync(relayFile, 'relay')
    writeFileSync(desktopFile, 'desktop')

    const removed = sweepOrphanedFishHistoryFiles(new Set(['deadbeef']), [dir])

    expect(removed).toBe(1)
    expect(existsSync(desktopFile)).toBe(false)
    expect(existsSync(relayFile)).toBe(true)
  })
})
