import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  PTY_A
} from '../main-owned-workspace-runtime-fixture'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { repairRestoredSwitches } from './restored-switch-plan'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'

// A restart after a crash between a switch's chat record and its tab's own write: the startup
// preparation repairs the saved tabs once, before terminals reconnect, from main's records and the
// terminal census. Nothing else at startup changes, and no later load repeats it.

const owner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.main
  }
}))

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, { location: { ...params.location, workspaceId: WORKTREE_ID } })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  owner.main = false
  vi.restoreAllMocks()
  await rig.dispose()
})

type Startup = ReturnType<typeof setupMainOwnedWorkspace>['runtime'] & {
  hasPersistedStructuredAgentSessionStore: () => boolean
  ensureStructuredAgentSessionHost: () => Promise<unknown>
  refreshMobileSessionPtyRecords: () => Promise<Set<string> | null>
}

/** The real startup preparation, with this load's census. */
function startup(
  runtime: ReturnType<typeof setupMainOwnedWorkspace>['runtime'],
  census: () => Set<string> | null
) {
  const internals = runtime as Startup
  vi.spyOn(internals, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  vi.spyOn(internals, 'ensureStructuredAgentSessionHost').mockResolvedValue(rig.host)
  vi.spyOn(internals, 'refreshMobileSessionPtyRecords').mockImplementation(async () => census())
  return async () => {
    await runtime.prepareStructuredAgentSessionStartupRestoration()
    return runtime.takeWindowRehydrateWorkspaces()
  }
}

const tabOf = (session: WorkspaceSessionState, tabId: string) =>
  session.unifiedTabs?.[WORKTREE_ID]?.find((tab) => tab.id === tabId)
/** What the saved tab holds: a chat, or (a terminal row, with or without a tab-bar entry yet) the
 *  terminal. */
const heldBy = (session: WorkspaceSessionState, tabId: string) =>
  tabOf(session, tabId)?.contentType ??
  (session.tabsByWorktree[WORKTREE_ID]?.some((row) => row.id === tabId) ? 'terminal' : undefined)

it.each([
  ['main owns the layout', true],
  ['a window or a windowless host owns it', false]
])('repairs a crashed switch once at startup, by the census: %s', async (_name, main) => {
  owner.main = main
  const cases = [
    { census: new Set<string>(), replaced: true },
    { census: new Set([PTY_A]), replaced: false },
    { census: null, replaced: false }
  ]
  for (const { census, replaced } of cases) {
    await rig.host.setSessionTabVisibility(id, true, TAB_ID, { move: true })
    const { runtime, session } = setupMainOwnedWorkspace({ pinned: true })
    const prepare = startup(runtime, () => census)
    const rehydrate = await prepare()
    if (replaced) {
      // The stopped terminal's tab takes the chat in place, pin kept, its terminal's records gone.
      expect(tabOf(session(), TAB_ID)).toMatchObject({
        contentType: 'agent-session',
        entityId: id,
        isPinned: true
      })
      expect(session().tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
      expect(rig.store.getSessionTabId(id)).toBe(TAB_ID)
      expect(rehydrate).toEqual(main ? [] : [WORKTREE_ID])
    } else {
      // A live or unknown terminal keeps its tab; the chat's record moves to a free one.
      expect(heldBy(session(), TAB_ID)).toBe('terminal')
      expect(rig.store.getSessionTabId(id)).toBe(structuredAgentSessionTabId(id))
      expect(rehydrate).toEqual([])
    }
    // Once per load: the terminal exiting later, a reload, or another restore repairs nothing more.
    const after = session()
    await prepare()
    await runtime.restoreStructuredAgentSessionTabs()
    expect(heldBy(session(), TAB_ID)).toBe(heldBy(after, TAB_ID))
    vi.restoreAllMocks()
  }
})

it('keeps every saved tab when the repair can’t be saved, and reports nothing repaired', async () => {
  await rig.host.setSessionTabVisibility(id, true, TAB_ID, { move: true })
  const { runtime, session } = setupMainOwnedWorkspace()
  const before = session()
  const store = (runtime as unknown as { store: { runDurableMutation: unknown } }).store
  vi.spyOn(
    store as { runDurableMutation: () => Promise<never> },
    'runDurableMutation'
  ).mockRejectedValue(new Error('disk full'))
  expect(await startup(runtime, () => new Set())()).toEqual([])
  expect(session()).toBe(before)
  expect(rig.store.getSessionTabId(id)).toBe(TAB_ID)
})

// Someone who never switched: no chat record names a terminal's tab, so startup writes nothing.
it.each([true, false])(
  'changes nothing for a load no switch crashed (main owns: %s)',
  async (main) => {
    owner.main = main
    await rig.host.setSessionTabVisibility(id, true, structuredAgentSessionTabId(id), {
      move: true
    })
    const { runtime, session } = setupMainOwnedWorkspace()
    const before = session()
    const generation = rig.host.getSessionTabGeneration(id)
    const store = (runtime as unknown as { store: { runDurableMutation: () => Promise<unknown> } })
      .store
    const writes = vi.spyOn(store, 'runDurableMutation')
    expect(await startup(runtime, () => new Set([PTY_A]))()).toEqual([])
    // Not even a queued write or a layout load.
    expect(writes).not.toHaveBeenCalled()
    expect(session()).toBe(before)
    expect(rig.host.getSessionTabGeneration(id)).toBe(generation)
  }
)

// A window that applied a switch and reloaded before its save: the new page of the same main finds
// the switch in the saved tabs; one a later close or switch superseded changes nothing.
it.each([
  ['still current', true],
  ['superseded', false]
])('writes a window’s unsaved switch for its reloaded page: %s', async (_name, current) => {
  const { runtime, session } = setupMainOwnedWorkspace()
  const internals = runtime as unknown as {
    unsavedWindowSwitches: {
      keeping: (
        windowOwned: boolean,
        target: object,
        content: object,
        current: () => boolean
      ) => (settlement: { kind: string }) => unknown
    }
  }
  internals.unsavedWindowSwitches.keeping(
    true,
    {
      workspace: WORKTREE_ID,
      tabId: TAB_ID,
      expectSource: { kind: 'terminal', terminalId: TAB_ID }
    },
    { kind: 'agent-session', sessionId: id, agent: 'codex' },
    () => current
  )({ kind: 'applied' })
  const rehydrate = await startup(runtime, () => new Set())()
  expect(heldBy(session(), TAB_ID)).toBe(current ? 'agent-session' : 'terminal')
  expect(rehydrate).toEqual(current ? [WORKTREE_ID] : [])
  // Taken once: a second reload has nothing left to write.
  expect(await runtime.takeWindowRehydrateWorkspaces()).toEqual([])
})

/** N ordinary terminals and N crashed switches in one workspace,  */
function crashedLoad(count: number) {
  const ids = Array.from({ length: count * 2 }, (_, index) => `t-${index}`)
  const base = getDefaultWorkspaceSession()
  let current: WorkspaceSessionState = {
    ...base,
    tabsByWorktree: {
      [WORKTREE_ID]: ids.map((tabId, index) => ({
        id: tabId,
        ptyId: null,
        worktreeId: WORKTREE_ID,
        title: tabId,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      ids.map((tabId) => [
        tabId,
        {
          root: { type: 'leaf', leafId: `${tabId}-leaf` },
          activeLeafId: null,
          expandedLeafId: null
        }
      ])
    )
  }
  const chats = Array.from({ length: count }, (_, index) => ({
    sessionId: `chat-${index}`,
    workspaceId: WORKTREE_ID,
    agent: 'codex' as const
  }))
  return {
    session: () => current,
    repair: () =>
      repairRestoredSwitches({
        hostId: 'local',
        store: {
          getWorkspaceSession: () => current,
          setWorkspaceSession: (next: WorkspaceSessionState) => {
            current = next
          },
          runDurableMutation: async (mutate) => mutate().value
        },
        host: {
          listSessionTabs: () => chats,
          getSessionTabId: (sessionId: string) => `t-${sessionId.slice('chat-'.length)}`,
          getSessionTabGeneration: () => 1,
          setSessionTabVisibility: async () => {}
        } as never,
        live: new Set(),
        ownsWorkspace: () => true
      })
  }
}

/** Elements every array scan visits while `run` runs: a scan inside a per-item loop shows up as
 *  N×N, where one indexed pass is N. */
async function arrayVisits(run: () => Promise<unknown>): Promise<number> {
  const methods = [
    'find',
    'findIndex',
    'filter',
    'some',
    'every',
    'map',
    'flatMap',
    'forEach',
    'includes',
    'indexOf',
    'reduce'
  ] as const
  const originals = methods.map((name) => [name, Array.prototype[name]] as const)
  let visits = 0
  for (const [name, original] of originals) {
    Object.defineProperty(Array.prototype, name, {
      configurable: true,
      writable: true,
      value(this: unknown[], ...args: unknown[]) {
        visits += this.length
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
    })
  }
  try {
    await run()
  } finally {
    for (const [name, original] of originals) {
      Object.defineProperty(Array.prototype, name, {
        configurable: true,
        writable: true,
        value: original
      })
    }
  }
  return visits
}

// The saved layout's own load and save (main's, once per write of any kind) aside, the repair's
// plan and patch are one indexed pass.
it('repairs N crashed switches in work linear in N beyond the one load and save', async () => {
  const work = async (count: number) => {
    const load = crashedLoad(count)
    const session = load.session()
    const baseline = await arrayVisits(async () => {
      saveWorkspaceLayout(loadWorkspaceLayout('local', session, nameBasedLoadContext()))
    })
    let repaired: string[] = []
    const visits = await arrayVisits(async () => {
      repaired = await load.repair()
    })
    expect(repaired).toEqual([WORKTREE_ID])
    const chatTabs = load
      .session()
      .unifiedTabs?.[WORKTREE_ID]?.filter((tab) => tab.contentType === 'agent-session')
    expect(chatTabs).toHaveLength(count)
    return visits - baseline
  }
  const small = await work(20)
  const large = await work(200)
  expect(large / small).toBeLessThanOrEqual(12)
})
