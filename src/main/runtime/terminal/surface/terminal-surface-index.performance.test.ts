// Perf contract (#44753, STA-16230): merging held phone rows looked up each workspace by scanning every workspace, O(n²) per merge.

import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import {
  addWorkspace,
  emptySession
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type { WorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-model'
import { TerminalSurfaceIndex } from './terminal-surface-index'

const hex = (index: number): string => index.toString(16).padStart(8, '0')
const keyOf = (index: number): string => `repo-1::/fleet/w${index}`

function fleet(count: number) {
  let session = emptySession()
  for (let index = 0; index < count; index++) {
    session = addWorkspace(session, keyOf(index), [
      {
        id: `group-${index}`,
        tabs: [{ id: `tab-${index}`, leaves: [[`${hex(index)}-0000-4000-8000-000000000000`]] }]
      }
    ])
  }
  const loaded = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    session,
    nameBasedLoadContext()
  )
  const reads = { count: 0 }
  const workspaces: Record<string, WorkspaceLayout> = {}
  for (const [key, workspace] of Object.entries(loaded.layout.workspaces)) {
    Object.defineProperty(workspaces, key, {
      enumerable: true,
      get: () => {
        reads.count++
        return workspace
      }
    })
  }
  const partition = { ...loaded, layout: { ...loaded.layout, workspaces } }
  const index = new TerminalSurfaceIndex({
    reads: () => ({
      readPartition: () => partition,
      onLayoutOperationCommitted: () => () => {}
    }),
    hostIds: () => [LOCAL_EXECUTION_HOST_ID],
    homeHostId: () => LOCAL_EXECUTION_HOST_ID,
    generatedTitlesEnabled: () => false,
    onChanged: () => {}
  })
  index.surfaces()
  return { index, reads }
}

it.each([
  [200, 0],
  [2_000, 0]
])(
  'reading every workspace’s held rows at %i workspaces scans %i partition workspaces',
  (workspaces, expected) => {
    const { index, reads } = fleet(workspaces)
    reads.count = 0
    for (let workspace = 0; workspace < workspaces; workspace++) {
      expect(index.lastSessionTabsOf(keyOf(workspace))).not.toBeNull()
    }
    expect(reads.count).toBe(expected)
  }
)
