import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'

import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  makeTerminalScrollbackSnapshotRef,
  type TerminalScrollbackSnapshotStorage
} from '../../../../pty/scrollback/terminal-scrollback-snapshots'
import { projectOrcadMigrationSessionScrollback } from './orcad-source-scrollback-state'

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
})
