// Perf contract (#44781, STA-16223): every Store write reloaded and republished the whole partition while layouts were watched, so starting terminals at about 1,900 workspaces stalled main for seconds.

import { expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  addWorkspace,
  emptySession
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type * as WorkspaceLoad from '../../../../shared/workspace-layout/persistence/workspace-layout-load-workspace'
import type * as WorkspacePublish from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from './workspace-layout-stream-events.test-fixture'

const work = vi.hoisted(() => ({ loads: 0, publishes: 0 }))

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

vi.mock(
  '../../../../shared/workspace-layout/persistence/workspace-layout-load-workspace',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WorkspaceLoad>()
    return {
      ...actual,
      loadWorkspace: (...args: Parameters<typeof actual.loadWorkspace>) => {
        work.loads++
        return actual.loadWorkspace(...args)
      }
    }
  }
)

vi.mock(
  '../../../../shared/workspace-layout/published-layout/workspace-layout-published',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WorkspacePublish>()
    return {
      ...actual,
      publishWorkspaceLayout: (...args: Parameters<typeof actual.publishWorkspaceLayout>) => {
        work.publishes++
        return actual.publishWorkspaceLayout(...args)
      }
    }
  }
)

const hex = (index: number): string => index.toString(16).padStart(8, '0')
const keyOf = (index: number): string => `repo-1::/fleet/w${index}`

function fleetSession(workspaces: number, started?: number) {
  let session = emptySession()
  for (let index = 0; index < workspaces; index++) {
    session = addWorkspace(session, keyOf(index), [
      {
        id: `group-${index}`,
        tabs: [
          {
            id: `tab-${index}`,
            leaves: [
              [
                `${hex(index)}-0000-4000-8000-000000000000`,
                index === started ? `repo-1::/fleet/w${index}@@${hex(index)}` : undefined
              ]
            ]
          }
        ]
      }
    ])
  }
  return session
}

type WriteListener = (
  hostId: ExecutionHostId | null,
  keys?: ReadonlySet<string>,
  refs?: ReadonlySet<string>
) => void

function watchedFleet(workspaces: number) {
  let session = fleetSession(workspaces)
  const written = new Set<WriteListener>()
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
    liveTitle: () => null
  })
  const reader = collectLayoutEvents()
  reader.seed(stream.subscribe(reader.listener).snapshot)
  work.loads = 0
  work.publishes = 0
  return {
    reader,
    write: (keys: string[], refs: string[] = []) => {
      session = fleetSession(workspaces, 7)
      written.forEach((listener) => listener(LOCAL_EXECUTION_HOST_ID, new Set(keys), new Set(refs)))
      stream.settledSeq()
    }
  }
}

it.each([200, 2_000])(
  'reloads and republishes one workspace for a write that reports it at %i workspaces',
  (workspaces) => {
    const fleet = watchedFleet(workspaces)

    fleet.write([keyOf(7)])

    expect(work.loads).toBe(1)
    expect(work.publishes).toBe(1)
    expect(fleet.reader.events.map((event) => event.key)).toEqual([keyOf(7)])
  }
)

it.each([200, 2_000])(
  'reloads and republishes one workspace for a write that names it only by its row at %i workspaces',
  (workspaces) => {
    const fleet = watchedFleet(workspaces)

    fleet.write([], ['row:tab-7'])

    expect(work.loads).toBe(1)
    expect(work.publishes).toBe(1)
    expect(fleet.reader.events.map((event) => event.key)).toEqual([keyOf(7)])
  }
)
