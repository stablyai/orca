import { afterEach, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from '../../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status/contracts/agent-status-subject'
import {
  closePiRpcAdapterFixtures,
  restart,
  sessionId,
  setup
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

async function workers() {
  const parent = makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: 'folder-1', workspaceKind: 'folder' },
    sessionId
  )
  const store = createAgentStatusStore({ epoch: 'epoch', mode: 'authority' })
  store.applyMutation({ parent: { subject: parent } })
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const logger = { warn: vi.fn(), error: vi.fn() }
  const h = await setup({}, undefined, undefined, {
    logger,
    onChildWorkEvidence: (_id, evidence) =>
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'pi', evidence })
  })
  const status = (key: string, text: string) =>
    h.connection.receive({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: key,
      statusText: text
    })
  const ready = (instance: string) => status('orca-background-work', `ready:${instance}`)
  const snapshot = (
    instance: string,
    sequence: number,
    children: unknown[],
    totalActive: number,
    extra = {}
  ) =>
    status(
      'orca-native-workers',
      JSON.stringify({
        version: 1,
        instance,
        sequence,
        state: 'known',
        fleet: { version: 1, totalActive, omitted: 0, entries: [] },
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          runs: children.length
            ? [{ id: 'workflow-run', kind: 'workflow', state: 'running', children }]
            : []
        },
        ...extra
      })
    )
  return {
    h,
    logger,
    ready,
    snapshot,
    status,
    records: () => store.getChildren(parent),
    live: () => store.getChildren(parent).filter((child) => child.membership === 'live')
  }
}

const scout = {
  id: 'scout-key',
  kind: 'step',
  agent: 'scout',
  label: 'Inspect launch',
  state: 'running',
  startedAt: 100
}
const builder = {
  id: 'builder-key',
  kind: 'step',
  agent: 'worker',
  label: 'Implement adapter',
  state: 'running',
  startedAt: 101
}

it('shows two then five confirmed workflow workers, never container or queued plans; empty snapshot clears', async () => {
  const w = await workers()
  w.ready('runtime-a')
  w.snapshot(
    'runtime-a',
    1,
    [scout, builder, { id: 'planned', kind: 'step', agent: 'reviewer', state: 'queued' }],
    1
  )
  expect(
    w.live().map((child) => ({
      name: child.name,
      description: child.description,
      stoppable: child.stoppable
    }))
  ).toEqual([
    { name: 'scout', description: 'Pi background worker: Inspect launch', stoppable: false },
    { name: 'worker', description: 'Pi background worker: Implement adapter', stoppable: false }
  ])
  w.snapshot(
    'runtime-a',
    2,
    [
      scout,
      builder,
      { id: 'review-a', kind: 'step', agent: 'reviewer', state: 'running', startedAt: 102 },
      { id: 'review-b', kind: 'step', agent: 'reviewer', state: 'running', startedAt: 103 },
      { id: 'test', kind: 'step', agent: 'tester', state: 'running', startedAt: 104 }
    ],
    6
  )
  expect(w.live().map((child) => child.name)).toEqual([
    'scout',
    'worker',
    'reviewer',
    'reviewer',
    'tester'
  ])
  w.snapshot('runtime-a', 3, [], 0)
  expect(w.live()).toEqual([])
  expect(w.records().map((child) => child.outcome)).toEqual([
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown'
  ])
})

it('recovers reload inventory while rejecting old runtime/sequence and failing closed on unavailable or partial inventory', async () => {
  const w = await workers()
  w.ready('runtime-a')
  w.snapshot('runtime-a', 1, [scout, builder], 3)
  w.ready('runtime-b')
  expect(w.live()).toEqual([])
  w.snapshot('runtime-a', 99, [scout, builder], 3)
  expect(w.live()).toEqual([])
  w.snapshot('runtime-b', 1, [scout, builder], 3)
  expect(w.live().map((child) => child.name)).toEqual(['scout', 'worker'])
  w.snapshot('runtime-b', 1, [], 0)
  expect(w.live().map((child) => child.name)).toEqual(['scout', 'worker'])
  w.status(
    'orca-native-workers',
    JSON.stringify({ version: 1, instance: 'runtime-b', sequence: 2, state: 'unknown' })
  )
  expect(w.live()).toEqual([])
  w.snapshot('runtime-b', 3, [scout, builder], 3)
  expect(w.live().map((child) => child.name)).toEqual(['scout', 'worker'])
  w.snapshot('runtime-b', 4, [scout, builder], 1)
  expect(w.live().map((child) => child.name)).toEqual(['scout', 'worker'])
  w.snapshot('runtime-b', 5, [scout, builder], 3, {
    asyncSnapshot: {
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      omitted: { runs: 0, children: 1, byteLimitExceeded: false },
      runs: []
    }
  })
  expect(w.live()).toEqual([])
  w.snapshot('runtime-b', 6, [scout, builder], 3)
  w.status('orca-native-workers', '{malformed')
  expect(w.live()).toEqual([])
  w.snapshot('runtime-b', 7, [scout, builder], 3)
  await w.h.adapter.closeSession(sessionId)
  w.snapshot('runtime-b', 8, [scout, builder], 3)
  expect(w.live()).toEqual([])
})

it('keeps one visible inventory warning for unavailable or partial reads and revises it on complete empty recovery', async () => {
  const w = await workers()
  const statuses = async () => (await w.h.rig.rows()).filter((row) => row.body.kind === 'status')
  w.ready('runtime-a')
  w.status(
    'orca-native-workers',
    JSON.stringify({ version: 1, instance: 'runtime-a', sequence: 1, state: 'unknown' })
  )
  const unavailable = await statuses()
  expect(unavailable.map((row) => row.body)).toEqual([
    expect.objectContaining({ kind: 'status', tone: 'warning' })
  ])
  expect(w.live()).toEqual([])
  w.snapshot('runtime-a', 2, [], 0, {
    asyncSnapshot: {
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      omitted: { runs: 0, children: 1, byteLimitExceeded: false },
      runs: []
    }
  })
  expect((await statuses()).map((row) => row.itemId)).toEqual([unavailable[0].itemId])
  w.snapshot('runtime-a', 3, [], 0)
  const recovered = await statuses()
  expect(
    recovered.map((row) => ({
      id: row.itemId,
      kind: row.body.kind,
      tone: row.body.kind === 'status' ? row.body.tone : undefined
    }))
  ).toEqual([{ id: unavailable[0].itemId, kind: 'status', tone: 'info' }])
  expect(w.live()).toEqual([])
})

it('ends a session with known inventory without publishing an unavailable warning', async () => {
  const w = await workers()
  const tones = async () =>
    (await w.h.rig.rows()).flatMap((row) => (row.body.kind === 'status' ? [row.body.tone] : []))
  w.ready('runtime-a')
  w.snapshot('runtime-a', 1, [scout], 1)
  expect(w.live()).toHaveLength(1)
  expect(await tones()).toEqual(['info'])
  w.logger.warn.mockClear()
  w.h.connection.exit()
  await w.h.adapter.drainObservedExits()
  expect(w.live()).toEqual([])
  expect(await tones()).toEqual(['info'])
  expect(w.logger.warn).not.toHaveBeenCalledWith(
    'Pi background worker inventory unavailable or partial',
    expect.anything()
  )
})

it('revises persisted warning when replacement runtime receives complete empty inventory before activation', async () => {
  const w = await workers()
  const statuses = async () => (await w.h.rig.rows()).filter((row) => row.body.kind === 'status')
  const unavailable = await statuses()
  expect(unavailable.map((row) => row.body)).toEqual([
    expect.objectContaining({ kind: 'status', tone: 'warning' })
  ])
  const { acquired } = await restart(w.h, (connection) => {
    connection.receive({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'orca-background-work',
      statusText: 'ready:replacement'
    })
    connection.receive({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'orca-native-workers',
      statusText: JSON.stringify({
        version: 1,
        instance: 'replacement',
        sequence: 1,
        state: 'known',
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          runs: []
        }
      })
    })
  })
  await w.h.adapter.open({
    sessionId,
    fence: 8,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  expect(
    (await statuses()).map((row) => ({
      id: row.itemId,
      kind: row.body.kind,
      tone: row.body.kind === 'status' ? row.body.tone : undefined
    }))
  ).toEqual([{ id: unavailable[0].itemId, kind: 'status', tone: 'info' }])
  expect(w.live()).toEqual([])
})
