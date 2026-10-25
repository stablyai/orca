// #23753: a terminal that survives a restart into a newly minted tab keeps posting hooks under the
// ORCA_PANE_KEY its env exported, so that key's agent status must follow it to the new pane.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import type { PtyProcessInfo } from '../providers/pty-process-info'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } =
  await import('./orca-runtime-test-fixtures.spec')

// Fresh per test: the hook server is a process singleton.
let OLD_TAB = ''
let OLD_LEAF = ''
let NEW_TAB = ''
let NEW_LEAF = ''
let OLD_PANE_KEY = ''
let NEW_PANE_KEY = ''
const SURVIVOR = `${TEST_WORKTREE_ID}@@survivor`
const OTHER = `${TEST_WORKTREE_ID}@@other`

function hookFromOldShell(state: 'working' | 'done'): void {
  agentHookServer.ingestRemote(
    {
      paneKey: OLD_PANE_KEY,
      tabId: OLD_TAB,
      worktreeId: TEST_WORKTREE_ID,
      payload: { state, prompt: 'fix the bug', agentType: 'claude' }
    },
    null
  )
}

function statesOn(paneKey: string): string[] {
  return agentHookServer.getStatusSnapshotForPane(paneKey).map((row) => row.state)
}

async function relaunch(listed: PtyProcessInfo[]) {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: async () => false,
    getForegroundProcess: async () => null,
    listProcesses: async () => listed
  })
  runtime.attachWindow(1)
  await runtime.listTerminals()
  return runtime
}

function showSurvivorIn(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  tabId: string,
  leafId: string
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId, worktreeId: TEST_WORKTREE_ID, title: 'Terminal', activeLeafId: leafId, layout: null }
    ],
    leaves: [{ tabId, worktreeId: TEST_WORKTREE_ID, leafId, paneRuntimeId: 1, ptyId: SURVIVOR }]
  })
}

function showSurvivorInNewTab(runtime: InstanceType<typeof OrcaRuntimeService>): void {
  showSurvivorIn(runtime, NEW_TAB, NEW_LEAF)
}

function listedSurvivor(spawnPaneKey?: string): PtyProcessInfo {
  return {
    id: SURVIVOR,
    cwd: TEST_WORKTREE_PATH,
    title: 'shell',
    worktreeId: TEST_WORKTREE_ID,
    ...(spawnPaneKey ? { paneKey: spawnPaneKey } : {})
  }
}

describe('agent status of a terminal re-homed after a restart', () => {
  beforeEach(() => {
    ;[OLD_TAB, OLD_LEAF, NEW_TAB, NEW_LEAF] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID()
    ]
    OLD_PANE_KEY = `${OLD_TAB}:${OLD_LEAF}`
    NEW_PANE_KEY = `${NEW_TAB}:${NEW_LEAF}`
  })

  afterEach(() => {
    agentHookServer.clearPaneKeyAliasesForPty(SURVIVOR)
    agentHookServer.clearPaneKeyAliasesForPty(OTHER)
  })

  it('moves the row filed under the exported key and routes later hooks to the new pane', async () => {
    hookFromOldShell('working')
    const runtime = await relaunch([listedSurvivor(OLD_PANE_KEY)])

    showSurvivorInNewTab(runtime)

    expect(statesOn(NEW_PANE_KEY)).toEqual(['working'])
    hookFromOldShell('done')
    expect(statesOn(NEW_PANE_KEY)).toEqual(['done'])
    expect(statesOn(OLD_PANE_KEY)).toEqual([])
  })

  it('keeps status under the exported key when an older host does not report it', async () => {
    const runtime = await relaunch([listedSurvivor()])

    showSurvivorInNewTab(runtime)
    hookFromOldShell('working')

    expect(statesOn(OLD_PANE_KEY)).toEqual(['working'])
    expect(statesOn(NEW_PANE_KEY)).toEqual([])
  })

  it('leaves the key alone while another live terminal shows that pane', async () => {
    const runtime = await relaunch([
      listedSurvivor(OLD_PANE_KEY),
      { id: OTHER, cwd: TEST_WORKTREE_PATH, title: 'shell', worktreeId: TEST_WORKTREE_ID }
    ])
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: OLD_TAB,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: OLD_LEAF,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: OLD_TAB,
          worktreeId: TEST_WORKTREE_ID,
          leafId: OLD_LEAF,
          paneRuntimeId: 1,
          ptyId: OTHER
        }
      ]
    })

    showSurvivorInNewTab(runtime)
    hookFromOldShell('working')

    expect(statesOn(OLD_PANE_KEY)).toEqual(['working'])
    expect(statesOn(NEW_PANE_KEY)).toEqual([])
  })

  it('returns a moved row to the exported key once a second live terminal also exported it', async () => {
    hookFromOldShell('working')
    const listed = [listedSurvivor(OLD_PANE_KEY)]
    const runtime = await relaunch(listed)
    showSurvivorInNewTab(runtime)
    listed.push({ ...listedSurvivor(OLD_PANE_KEY), id: OTHER })

    await runtime.listTerminals()

    expect(statesOn(OLD_PANE_KEY)).toEqual(['working'])
    expect(statesOn(NEW_PANE_KEY)).toEqual([])
    hookFromOldShell('done')
    expect(statesOn(OLD_PANE_KEY)).toEqual(['done'])
  })

  it('leaves the row under the exported key when another live terminal exported the destination', async () => {
    hookFromOldShell('working')
    const runtime = await relaunch([
      listedSurvivor(OLD_PANE_KEY),
      { ...listedSurvivor(NEW_PANE_KEY), id: OTHER }
    ])

    showSurvivorInNewTab(runtime)

    expect(statesOn(OLD_PANE_KEY)).toEqual(['working'])
    expect(statesOn(NEW_PANE_KEY)).toEqual([])
  })

  it('brings the row back when the terminal is shown in its exported pane again', async () => {
    hookFromOldShell('working')
    const runtime = await relaunch([listedSurvivor(OLD_PANE_KEY)])
    showSurvivorInNewTab(runtime)

    showSurvivorIn(runtime, OLD_TAB, OLD_LEAF)

    expect(statesOn(OLD_PANE_KEY)).toEqual(['working'])
    expect(statesOn(NEW_PANE_KEY)).toEqual([])
    hookFromOldShell('done')
    expect(statesOn(OLD_PANE_KEY)).toEqual(['done'])
  })
})
