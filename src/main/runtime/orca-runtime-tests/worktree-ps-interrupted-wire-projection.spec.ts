import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { makeAgentStatusStoreWiring } from '../agent-status-store-wiring.test-fixture'

/**
 * `interrupted` is now a turn fact internally, so it can ride a row that is still `working`. The
 * published `worktree ps` row is what paired desktops and phones read, and there it has always
 * meant "finished by interrupt" — so it stays clamped on the wire. A client that predates this
 * change must see exactly what it saw before.
 */
const LEAF_ID = '99999999-9999-4999-8999-999999999999'
const PANE_KEY = `tab-wire:${LEAF_ID}`

function wiredRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store, undefined, makeAgentStatusStoreWiring().deps)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-wire',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Claude',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-wire',
        worktreeId: TEST_WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'wire-pty'
      }
    ]
  })
  return runtime
}

async function listedAgentRow(runtime: OrcaRuntimeService) {
  const listed = await runtime.getWorktreePs()
  const agents = listed.worktrees.find(
    (worktree) => worktree.worktreeId === TEST_WORKTREE_ID
  )?.agents
  return agents?.find((agent) => agent.paneKey === PANE_KEY)
}

describe('worktree ps keeps the published interrupted field clamped', () => {
  it('publishes false for a stopped turn whose pane is still working', async () => {
    const runtime = wiredRuntime()
    runtime.onPtyData(
      'wire-pty',
      '\x1b]9999;{"state":"working","workingMode":"monitoring","prompt":"ship it","agentType":"claude","interrupted":true}\x07',
      1
    )

    expect(await listedAgentRow(runtime)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      interrupted: false
    })
  })

  it('publishes true only once the pane also reports finished', async () => {
    const runtime = wiredRuntime()
    runtime.onPtyData(
      'wire-pty',
      '\x1b]9999;{"state":"done","prompt":"ship it","agentType":"claude","interrupted":true}\x07',
      1
    )

    expect(await listedAgentRow(runtime)).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })
})
