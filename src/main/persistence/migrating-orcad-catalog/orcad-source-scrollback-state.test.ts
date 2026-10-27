import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  makeTerminalScrollbackSnapshotRef,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  hasDuplicateOrcadMigrationScrollbackDescriptors,
  projectOrcadMigrationSessionScrollback
} from './orcad-source-scrollback-state'

const FIRST: OrcadMigrationTerminalScrollbackSnapshot = {
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ref: `v1-${'1'.repeat(32)}`,
  sha256: 'a'.repeat(64),
  byteLength: 1
}

let root: string
let storage: TerminalScrollbackSnapshotStorage

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-source-scrollback-'))
  storage = { snapshotRoot: join(root, 'primary'), fallbackSnapshotRoot: join(root, 'fallback') }
  mkdirSync(join(root, 'primary'))
  mkdirSync(join(root, 'fallback'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function project(layout: Partial<TerminalLayoutSnapshot>) {
  return projectOrcadMigrationSessionScrollback(
    {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: {
        'tab-1': { root: null, activeLeafId: null, expandedLeafId: null, ...layout }
      }
    },
    storage
  )
}

function storeSnapshot(leafId: string, contents: string | number, dir = 'primary'): string {
  const ref = makeTerminalScrollbackSnapshotRef('tab-1', leafId)
  const path = join(root, dir, `${ref}.bin`)
  writeFileSync(path, typeof contents === 'string' ? contents : '')
  if (typeof contents === 'number') {
    truncateSync(path, contents)
  }
  return ref
}

describe('orcad source scrollback projection', () => {
  it('moves panes that saved no terminal history without blocking the move', () => {
    const projected = project({
      buffersByLeafId: { 'leaf-empty': '' },
      scrollbackRefsByLeafId: {
        'leaf-deleted': makeTerminalScrollbackSnapshotRef('tab-1', 'leaf-deleted'),
        'leaf-zero': storeSnapshot('leaf-zero', 0)
      }
    })

    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots).toEqual([])
    expect(projected.session.terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId).toBeUndefined()
  })

  it('carries history from the fallback root when the primary copy is empty or missing', () => {
    const zeroRef = storeSnapshot('leaf-zero', 0)
    storeSnapshot('leaf-zero', 'zero', 'fallback')
    const missingRef = storeSnapshot('leaf-missing', 'missing', 'fallback')

    const projected = project({
      scrollbackRefsByLeafId: { 'leaf-zero': zeroRef, 'leaf-missing': missingRef }
    })

    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots.map((snapshot) => [snapshot.leafId, snapshot.byteLength])).toEqual([
      ['leaf-missing', 7],
      ['leaf-zero', 4]
    ])
  })

  it('still blocks the move on saved history it cannot read', () => {
    const projected = project({
      scrollbackRefsByLeafId: {
        'leaf-big': storeSnapshot('leaf-big', TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1)
      }
    })

    expect(projected.blockedItems).toEqual([
      'saved terminal history Orca could not read for tab tab-1'
    ])
  })

  it('refuses duplicate refs or tab/leaf identities across merged fragments', () => {
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, tabId: 'tab-2', leafId: 'leaf-2' }
      ])
    ).toBe(true)
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        { ...FIRST, ref: `v1-${'2'.repeat(32)}` }
      ])
    ).toBe(true)
    expect(
      hasDuplicateOrcadMigrationScrollbackDescriptors([
        FIRST,
        {
          ...FIRST,
          tabId: 'tab-2',
          leafId: 'leaf-2',
          ref: `v1-${'2'.repeat(32)}`
        }
      ])
    ).toBe(false)
  })
})
