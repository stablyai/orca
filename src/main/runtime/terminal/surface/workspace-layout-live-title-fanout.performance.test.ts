// Perf contract (STA-16160): a live title change rechecked every published workspace while a layout subscriber was attached.

import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from './workspace-layout-stream-events.test-fixture'

const ptyOf = (index: number): string => `repo-1::/fleet/w${index}@@pty${index}`

function fleet(workspaces: number) {
  let session = emptySession()
  for (let index = 0; index < workspaces; index++) {
    session = addWorkspace(session, `repo-1::/fleet/w${index}`, [
      { id: `group-${index}`, tabs: [{ id: `tab-${index}`, leaves: [[leaf(1), ptyOf(index)]] }] }
    ])
  }
  const titles = new Map<string, string>()
  const titleReads = { count: 0 }
  const stream = new WorkspaceLayoutStream({
    store: () => ({
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID]
    }),
    homeHostId: () => LOCAL_EXECUTION_HOST_ID,
    liveTitle: (ptyId) => {
      titleReads.count++
      return titles.get(ptyId) ?? null
    }
  })
  return { stream, titles, titleReads }
}

it.each([200, 2_000])('reads one live title per title change at %i workspaces', (workspaces) => {
  const { stream, titles, titleReads } = fleet(workspaces)
  const reader = collectLayoutEvents()
  const { snapshot } = stream.subscribe(reader.listener)
  reader.seed(snapshot)
  expect(snapshot).toHaveLength(workspaces)
  titleReads.count = 0

  titles.set(ptyOf(7), 'agent task 1')
  stream.markLiveTitlesDirty(ptyOf(7))
  stream.settledSeq()

  expect(titleReads.count).toBe(1)
  expect(reader.events.map((event) => event.key)).toEqual(['repo-1::/fleet/w7'])
  expect(reader.layouts.get('repo-1::/fleet/w7')?.tabs[0]?.terminal?.panes[0]?.liveTitle).toBe(
    'agent task 1'
  )
})
