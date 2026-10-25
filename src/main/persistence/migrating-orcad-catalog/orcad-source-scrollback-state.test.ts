import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  getTerminalScrollbackSnapshotPath,
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
  storage = { snapshotRoot: join(root, 'terminal-scrollback') }
  mkdirSync(storage.snapshotRoot!, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function project(layout: Partial<TerminalLayoutSnapshot>) {
  const session = {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null, ...layout }
    }
  }
  return projectOrcadMigrationSessionScrollback(session, storage)
}

function storedRef(leafId: string, size: number): string {
  const ref = makeTerminalScrollbackSnapshotRef('tab-1', leafId)
  const path = getTerminalScrollbackSnapshotPath(ref, storage)!
  writeFileSync(path, '')
  truncateSync(path, size)
  return ref
}

describe('orcad source scrollback projection', () => {
  it('moves panes that saved no terminal history without blocking the move', () => {
    const projected = project({
      buffersByLeafId: { 'leaf-empty': '' },
      scrollbackRefsByLeafId: {
        'leaf-deleted': makeTerminalScrollbackSnapshotRef('tab-1', 'leaf-deleted'),
        'leaf-zero': storedRef('leaf-zero', 0)
      }
    })

    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots).toEqual([])
    expect(projected.session.terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId).toBeUndefined()
  })

  it('still blocks the move on saved history it cannot read', () => {
    const projected = project({
      scrollbackRefsByLeafId: {
        'leaf-big': storedRef('leaf-big', TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1)
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
