// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { WORKTREE_ID } from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import { savedTranscript } from './structured-agent-session-switch-execution.test-fixture'
import {
  executionOwnerRig,
  type ExecutionOwnerRig
} from './structured-agent-session-switch-terminal-admission.test-fixture'

// Whether the conversation's running terminal is a retry's own comes from the window that holds
// the switched tab, never from the tab graph main last heard, which can trail the window.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(async () => {})
}))
const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()
const { createTestStore, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const windowStore = createTestStore()
vi.mock('@/store', () => ({ useAppStore: windowStore }))
const { setWindowTabContent } = await import('@/lib/switched-tab-content')

/** The chat's tab: not the id main would guess for it. */
const T = 'tab-T'

let rig: RestTestRig
let owner: ExecutionOwnerRig | undefined
const unsubscribes: (() => void)[] = []
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
  await owner?.dispose()
  owner = undefined
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

/** The window owns the layout: T holds the chat, and decisions and changes go to its store. */
async function windowOwnedSwitch(opts: { loseFirstAnswer?: boolean } = {}) {
  await savedTranscript(rig)
  vi.spyOn(cliTranscript, 'nativeConversationContent').mockReturnValue('saved')
  const nativeId = rig.store.getRecord(id)!.providerHandleChain.at(-1)!.handle.nativeId
  const r = (owner = executionOwnerRig({ host: rig.host, root: rig.root, nativeId }))
  seedStore(windowStore, {
    activeWorktreeId: WORKTREE_ID,
    worktreesByRepo: { 'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1' })] },
    tabsByWorktree: { [WORKTREE_ID]: [] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: T,
          entityId: id,
          groupId: 'group-1',
          worktreeId: WORKTREE_ID,
          contentType: 'agent-session'
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: T,
          tabOrder: [T],
          recentTabIds: [T]
        })
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
    layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-1' } },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {}
  })
  let loseAnswer = opts.loseFirstAnswer === true
  vi.spyOn(r.runtime, 'setSwitchedTabContent').mockImplementation(
    async (worktreeId, request, decide) => {
      const answer = setWindowTabContent({
        worktreeId,
        tabId: request.tabId,
        expectSource: request.expectSource,
        content: request.window,
        focus: false,
        ...(decide ? { decide } : {}),
        ...(request.exact ? { exact: true } : {})
      })
      if (!decide && answer.retargeted && request.window.kind === 'terminal') {
        // The window's pane for that terminal views it.
        unsubscribes.push(r.runtime.registerRawTerminalViewSubscriber(request.window.ptyId))
        if (loseAnswer) {
          loseAnswer = false
          throw new Error('window answer lost')
        }
      }
      return answer
    }
  )
  const run = (invocationId: string, named = true) =>
    executeStructuredSessionSwitch(
      { sessionId: id, execution: { invocationId, ...(named ? { sourceTabId: T } : {}) } },
      { runtime: r.runtime },
      'terminal'
    )
  const shownInT = () => windowStore.getState().unifiedTabsByWorktree[WORKTREE_ID]
  return { r, run, shownInT }
}

it('a retry after the window put the terminal in the chat’s tab and its answer was lost adopts that terminal', async () => {
  const { r, run, shownInT } = await windowOwnedSwitch({ loseFirstAnswer: true })
  await run('first')
  const first = r.spawned[0]!
  expect(shownInT()).toEqual([
    expect.objectContaining({ id: T, entityId: first.tabId, contentType: 'terminal' })
  ])
  // Main never heard the window's graph with that terminal in T.
  expect(await run('retry')).toMatchObject({ status: 'completed', terminal: first.tabId })
  expect(r.started()).toBe(1)
  expect(shownInT()).toEqual([expect.objectContaining({ id: T, entityId: first.tabId })])
})

it('a retry after a switch whose answer to the client was lost returns that terminal, and stops or starts nothing again', async () => {
  const { r, run } = await windowOwnedSwitch()
  const first = await run('first')
  expect(first).toMatchObject({ status: 'completed', terminal: r.spawned[0]!.tabId })
  // The window's graph main hears last trails the switch: no tab in it shows the terminal.
  r.runtime.storeMobileSessionSnapshot(WORKTREE_ID, {
    worktree: WORKTREE_ID,
    publicationEpoch: 'window',
    snapshotVersion: Number.MAX_SAFE_INTEGER,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  })
  expect(await run('retry')).toEqual(first)
  expect(r.stop).toHaveBeenCalledTimes(1)
  expect(r.spawned).toHaveLength(1)
})

it.each([
  ['naming the chat’s tab', true],
  ['naming no tab', false]
])(
  'after main restarts, a retry %s adopts the terminal the window keeps there',
  async (_name, named) => {
    const { r, run, shownInT } = await windowOwnedSwitch()
    const first = await run('first', named)
    expect(first).toMatchObject({ status: 'completed', terminal: r.spawned[0]!.tabId })
    // Main restarts: its switches and claims are gone and it has heard no tab graph yet; the
    // execution owner keeps the terminal, which the window still shows in T.
    r.relaunch()
    setStructuredAgentSessionHost(await rig.restart())
    r.runtime.storeMobileSessionSnapshot(WORKTREE_ID, {
      worktree: WORKTREE_ID,
      publicationEpoch: 'restarted',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    expect(await run('after-restart', named)).toMatchObject({
      status: 'completed',
      terminal: r.spawned[0]!.tabId
    })
    expect(r.started()).toBe(1)
    expect(shownInT()).toEqual([expect.objectContaining({ id: T, entityId: r.spawned[0]!.tabId })])
  }
)
