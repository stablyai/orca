import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-ledger-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const committed = (rewrittenStores: string[]) =>
  cutover('move-1', 'destination-committed', { rewrittenStores })

describe('WSL move rewrite ledger', () => {
  it('grows append-only while the desktop rewrites', () => {
    seedWslMoveCutover(userDataPath, committed([]))
    writeWslMoveCutover(userDataPath, committed(['a']))
    writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['a', 'b'])
  })

  it.each([
    ['removes an entry', ['a']],
    ['reorders entries', ['b', 'a']],
    ['replaces an entry', ['a', 'c']],
    ['duplicates an entry', ['a', 'b', 'a']]
  ])('refuses a write that %s', (_label, rewrittenStores) => {
    seedWslMoveCutover(userDataPath, committed(['a', 'b']))
    expect(() => writeWslMoveCutover(userDataPath, committed(rewrittenStores))).toThrow(
      'wsl_move_ledger_changed'
    )
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['a', 'b'])
  })

  it('refuses ledger entries outside the rewrite phase', () => {
    expect(() =>
      writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared', { rewrittenStores: ['a'] }))
    ).toThrow('wsl_move_ledger_changed')
    seedWslMoveCutover(userDataPath, cutover('move-1', 'blobs-transferred'))
    expect(() => writeWslMoveCutover(userDataPath, committed(['a']))).toThrow(
      'wsl_move_ledger_changed'
    )
  })

  it('advances to client-rewritten only once every registered store is recorded', () => {
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    registerWslMoveDesktopRewriteStore({ id: 'a', side: 'main', run: () => {}, flush: () => {} })
    registerWslMoveDesktopRewriteStore({ id: 'b', side: 'renderer' })
    seedWslMoveCutover(userDataPath, committed(['a']))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'client-rewritten', { rewrittenStores: ['a'] })
      )
    ).toThrow('wsl_move_rewrite_incomplete')
    writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'client-rewritten', { rewrittenStores: ['a', 'b'] })
    )
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('client-rewritten')
  })

  it('refuses client-rewritten while the store registry is incomplete', () => {
    seedWslMoveCutover(userDataPath, committed([]))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))).toThrow(
      'wsl_move_rewrite_incomplete'
    )
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('client-rewritten')
  })
})
