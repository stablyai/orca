import { expect, it } from 'vitest'
import { createRuntimeAgentProjections } from '../construction/runtime-agent-projections'
import { MIRROR_LEAVES_STEP_1 } from '../runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees as Inventory } from './session-tabs-inventory'
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged as Publication } from './session-tabs-change-publication'

const WORKTREES = 20
const leafOf = (i: number) => `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`

/** The runtime parts an inventory or broadcast pass reads, with `terminals` live terminals over
 *  20 worktrees; the passes and the frame builder are the runtime's own methods. */
function runtime(terminals: number) {
  const leaves: RuntimeLeafRecord[] = []
  const ptys: RuntimePtyWorktreeRecord[] = []
  for (let i = 0; i < terminals; i++) {
    const worktreeId = `w${i % WORKTREES}`
    leaves.push({ ...MIRROR_LEAVES_STEP_1[0], tabId: `tab${i}`, worktreeId, ptyId: `pty-${i}` })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only these fields.
    ptys.push({ ptyId: `pty-${i}`, incarnationId: 'inc', worktreeId } as RuntimePtyWorktreeRecord)
  }
  const agentProjections = createRuntimeAgentProjections(
    {
      getExistingOrchestrationDb: () => null,
      resolveOrchestrationWorkerServer: () => {
        throw new Error('unpaired')
      }
    },
    {
      getDb: () => null,
      getLeaves: () => leaves,
      getPtys: () => ptys,
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: (leaf) => `term_${leaf.tabId}`,
      issuePtyHandle: () => '',
      makePaneKey: (leaf) => `${leaf.tabId}:${leafOf(Number(leaf.tabId.slice(3)))}`,
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => null
    }
  )
  const frames: RuntimeMobileSessionTabsResult[] = []
  const snapshot = (worktree: string) => ({
    worktree,
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  })
  const host = {
    agentProjections,
    mobileSessionTabsByWorktree: new Map(
      Array.from({ length: WORKTREES }, (_, i) => [`w${i}`, snapshot(`w${i}`)])
    ),
    mobileSessionTabsChangeSequence: 0,
    mobileSessionTabListeners: new Set([
      { listener: (frame: RuntimeMobileSessionTabsResult) => frames.push(frame) }
    ]),
    getKnownWorkspaceSessionWorktreeIds: () => [],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => undefined,
    refreshMobileSessionPtyInventory: async () => null,
    restoreLivePairedRendererSessionOwnedMobileTerminals: () => undefined,
    projectMobileSessionTabsForClient: (frame: RuntimeMobileSessionTabsResult) => frame,
    toMobileSessionTabsResult: (frame: RuntimeMobileSessionTabsResult) => frame,
    toMobileSessionTabsFrames: Reflect.get(Publication.prototype, 'toMobileSessionTabsFrames')
  }
  const call = (owner: object, method: string) =>
    (Reflect.get(owner, method) as () => unknown).call(host)
  const walks = () => agentProjections.senders.workForTest()
  return {
    senders: agentProjections.senders,
    frames,
    walks,
    inventory: () =>
      call(Inventory.prototype, 'collectAllMobileSessionTabs') as Promise<{
        snapshots: RuntimeMobileSessionTabsResult[]
      }>,
    broadcast: () => call(Publication.prototype, 'notifyMobileSessionTabSnapshots')
  }
}

it.each([100, 1000])(
  'walks the live terminals once per inventory or broadcast pass, at %i terminals',
  async (terminals) => {
    const h = runtime(terminals)
    h.senders.build()
    const revision = h.senders.publisher.current().revision
    const pass = async (run: () => unknown) => {
      const before = h.walks()
      await run()
      const after = h.walks()
      return {
        leaves: after.leafVisits - before.leafVisits,
        ptys: after.ptyVisits - before.ptyVisits
      }
    }
    const once = { leaves: terminals, ptys: terminals }
    const listed = await h.inventory()
    expect(listed.snapshots).toHaveLength(WORKTREES)
    expect(listed.snapshots[3].agentSenderAssociations?.associations).toHaveLength(
      terminals / WORKTREES
    )
    expect(await pass(h.inventory)).toEqual(once)
    expect(await pass(h.broadcast)).toEqual(once)
    expect(h.frames).toHaveLength(WORKTREES)
    // One graph build or one frame walks them once too; unchanged terminals publish nothing.
    expect(await pass(() => h.senders.buildForGraph(revision))).toEqual(once)
    expect(await pass(() => h.senders.buildForFrame('w0'))).toEqual(once)
    expect(h.senders.publisher.current().revision).toEqual(revision)
  }
)
