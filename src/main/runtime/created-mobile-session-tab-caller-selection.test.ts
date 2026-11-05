/** Create selects only its caller; shared selection stays put and no tap-style PTY respawn runs. */
import { expect, it, vi } from 'vitest'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
await import('./orca-runtime-test-scenario-builders.spec')

const WT = TEST_WORKTREE_ID

function pairedRuntime(clientKind?: 'mobile' | 'runtime') {
  let next = 0
  const spawn = vi.fn(async () => ({ id: `pty-${++next}` }))
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const caller: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged(
    (snapshot) => caller.push(snapshot),
    'device-caller',
    clientKind
  )
  runtime.onMobileSessionTabsChanged(() => {}, 'device-bystander', clientKind)
  return { runtime, spawn, caller }
}

async function createPane(runtime: InstanceType<typeof OrcaRuntimeService>) {
  const created = await runtime.createTerminal(`id:${WT}`)
  const pane = parsePaneKey(created.paneKey ?? '')
  if (!pane) {
    throw new Error(`createTerminal returned no pane key: ${created.paneKey}`)
  }
  return { tabId: pane.tabId, leafId: pane.leafId, id: `${pane.tabId}::${pane.leafId}` }
}

it('selects a launched terminal for the caller only, without spawning again', async () => {
  const { runtime, spawn, caller } = pairedRuntime()
  const first = await createPane(runtime)
  const launched = await createPane(runtime)
  expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(first.id)
  const previous = caller.at(-1)!

  expect(runtime.selectCreatedMobileSessionTabForClient(WT, launched, 'device-caller')).toBe(true)

  const selected = caller.at(-1)!
  expect(selected.activeTabId).toBe(launched.id)
  // The client fences a frame from another publication or behind its last version.
  expect(selected.publicationEpoch).toBe(previous.publicationEpoch)
  expect(selected.snapshotVersion).toBe(previous.snapshotVersion + 1)
  expect((await runtime.listMobileSessionTabs(`id:${WT}`, 'device-caller')).activeTabId).toBe(
    launched.id
  )
  expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(first.id)
  expect((await runtime.listMobileSessionTabs(`id:${WT}`, 'device-bystander')).activeTabId).toBe(
    first.id
  )
  expect(spawn).toHaveBeenCalledTimes(2)
})

it('selects a launched chat by its session for the caller only', async () => {
  const { runtime, caller } = pairedRuntime()
  const first = await createPane(runtime)
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: 'sess-1',
    agent: 'claude',
    activate: false
  })

  expect(
    runtime.selectCreatedMobileSessionTabForClient(WT, { sessionId: 'sess-1' }, 'device-caller')
  ).toBe(true)

  expect(caller.at(-1)?.activeTabId).toBe('agent-session:sess-1')
  expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(first.id)
  expect((await runtime.listMobileSessionTabs(`id:${WT}`, 'device-bystander')).activeTabId).toBe(
    first.id
  )
})
