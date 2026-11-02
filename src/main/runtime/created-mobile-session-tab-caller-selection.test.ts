/** Create selects only its caller; shared selection stays put and no tap-style PTY respawn runs. */
import { expect, it, vi } from 'vitest'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID, HEADLESS_LEAF_ID } =
  await import('./orca-runtime-test-fixtures.spec')
const { makePendingAgentTabActivationRuntime } =
  await import('./orca-runtime-test-scenario-builders.spec')

const WT = TEST_WORKTREE_ID

function pairedRuntime() {
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
  runtime.onMobileSessionTabsChanged((snapshot) => caller.push(snapshot), 'device-caller')
  runtime.onMobileSessionTabsChanged(() => {}, 'device-bystander')
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

  expect(runtime.selectCreatedMobileSessionTabForClient(WT, launched, 'device-caller')).toBe(true)

  expect(caller.at(-1)?.activeTabId).toBe(launched.id)
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

it('reports a tab that is not published instead of selecting something else', async () => {
  const { runtime, caller } = pairedRuntime()
  await createPane(runtime)
  const before = caller.length

  expect(
    runtime.selectCreatedMobileSessionTabForClient(WT, { sessionId: 'missing' }, 'device-caller')
  ).toBe(false)
  expect(caller).toHaveLength(before)
})

it('never materializes a pane that is not ready, as a tap would', async () => {
  const { runtime, spawn } = makePendingAgentTabActivationRuntime()
  const listed = await runtime.listMobileSessionTabs(`id:${WT}`)
  expect(listed.tabs[0]).toMatchObject({ launchAgent: 'claude', status: 'pending-handle' })

  expect(
    runtime.selectCreatedMobileSessionTabForClient(
      WT,
      { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID },
      'device-caller'
    )
  ).toBe(true)

  const selected = await runtime.listMobileSessionTabs(`id:${WT}`, 'device-caller')
  expect(selected.activeTabId).toBe(`host-tab::${HEADLESS_LEAF_ID}`)
  // Respawn crosses several awaits; an immediate absence assertion would be premature.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(spawn).not.toHaveBeenCalled()
})
