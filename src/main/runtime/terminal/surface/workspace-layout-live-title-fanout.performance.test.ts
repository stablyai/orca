// Perf contract (#44627, STA-16160): a live title change or one-workspace write rechecked every published workspace while a layout subscriber was attached.

import { expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  addWorkspace,
  emptySession
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from './workspace-layout-stream-events.test-fixture'

const hex = (index: number): string => index.toString(16).padStart(8, '0')
// Pane ids are unique across a partition; a repeated one is reminted and loses its terminal.
const leafOf = (index: number): string => `${hex(index)}-0000-4000-8000-000000000000`
const ptyOf = (index: number): string => `repo-1::/fleet/w${index}@@${hex(index)}`

function fleetSession(workspaces: number, renamed?: number) {
  let session = emptySession()
  for (let index = 0; index < workspaces; index++) {
    session = addWorkspace(session, `repo-1::/fleet/w${index}`, [
      {
        id: `group-${index}`,
        tabs: [
          {
            id: `tab-${index}`,
            leaves: [[leafOf(index), ptyOf(index)]],
            ...(index === renamed ? { title: 'Renamed' } : {})
          }
        ]
      }
    ])
  }
  return session
}

function fleet(workspaces: number) {
  let session = fleetSession(workspaces)
  const written = new Set<(hostId: ExecutionHostId | null) => void>()
  const titles = new Map<string, string>()
  const titleReads = { count: 0 }
  const stream = new WorkspaceLayoutStream({
    store: () => ({
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      onWorkspaceSessionWritten: (listener) => {
        written.add(listener)
        return () => written.delete(listener)
      }
    }),
    homeHostId: () => LOCAL_EXECUTION_HOST_ID,
    liveTitle: (ptyId) => {
      titleReads.count++
      return titles.get(ptyId) ?? null
    }
  })
  const reader = collectLayoutEvents()
  const { snapshot } = stream.subscribe(reader.listener)
  reader.seed(snapshot)
  expect(snapshot).toHaveLength(workspaces)
  titleReads.count = 0
  const write = (next: typeof session): void => {
    session = next
    written.forEach((listener) => listener(LOCAL_EXECUTION_HOST_ID))
  }
  return { stream, reader, titles, titleReads, write }
}

it.each([200, 2_000])('reads one live title per title change at %i workspaces', (workspaces) => {
  const { stream, reader, titles, titleReads } = fleet(workspaces)
  titles.set(ptyOf(7), 'agent task 1')
  stream.markLiveTitlesDirty(ptyOf(7))
  stream.settledSeq()

  expect(titleReads.count).toBe(1)
  expect(reader.events.map((event) => event.key)).toEqual(['repo-1::/fleet/w7'])
  expect(reader.layouts.get('repo-1::/fleet/w7')?.tabs[0]?.terminal?.panes[0]?.liveTitle).toBe(
    'agent task 1'
  )
})

it.each([200, 2_000])(
  'reads one live title for a write that changes one workspace at %i workspaces',
  (workspaces) => {
    const { stream, reader, titleReads, write } = fleet(workspaces)

    write(fleetSession(workspaces, 7))
    stream.settledSeq()

    expect(titleReads.count).toBe(1)
    expect(reader.events.map((event) => event.key)).toEqual(['repo-1::/fleet/w7'])
  }
)
