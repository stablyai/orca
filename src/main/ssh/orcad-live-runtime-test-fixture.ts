import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'

export class LiveCleanupRuntime extends OrcaRuntimeService {
  inspectCleanupState() {
    return {
      models: this.headlessTerminals,
      ptys: this.ptysById,
      leaves: this.leaves,
      handles: this.handleByPtyId,
      mobile: this.mobileSessionTabsByWorktree
    }
  }

  seedCleanupSnapshot(
    worktree: string,
    tabId: string,
    leaves: { leafId: string; ptyId: string }[]
  ) {
    this.storeMobileSessionSnapshot(worktree, {
      worktree,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: leaves.map(({ leafId, ptyId }) => ({
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        parentTabId: tabId,
        leafId,
        ptyId,
        title: tabId,
        isActive: false
      }))
    })
  }
}

export async function liveCleanupRuntimeFixture(cutover: OrcadMigrationSourceCutover) {
  const runtime = new LiveCleanupRuntime()
  const bindings = cutover.liveTerminalBindings!
  const entries = bindings.map(({ identity, surfaceBinding }) => {
    const scope = parseWorkspaceKey(surfaceBinding.workspaceKey)!
    return {
      ptyId: toAppSshPtyId(cutover.manifest.source.sshTargetId, identity.terminalId),
      connectionId: cutover.manifest.source.sshTargetId,
      worktreeId: scope.type === 'worktree' ? scope.worktreeId : surfaceBinding.workspaceKey,
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      incarnationId: identity.incarnationId
    }
  })
  const other = {
    ptyId: toAppSshPtyId('unrelated', 'pty'),
    connectionId: 'unrelated',
    worktreeId: 'folder:unrelated',
    tabId: 'unrelated',
    leafId: '11111111-1111-4111-8111-111111111111',
    incarnationId: 'unrelated'
  }
  const all = [...entries, other]
  for (const entry of all) {
    runtime.registerPty(entry.ptyId, entry.worktreeId, entry.connectionId, entry)
    runtime.preAllocateHandleForPty(entry.ptyId)
    await runtime.acceptPtyDataBounded(entry.ptyId, 'data', Date.now()).completion
  }
  const tabs = [...new Map(all.map((entry) => [entry.tabId, entry])).values()]
  runtime.syncWindowGraph(1, {
    tabs: tabs.map(({ tabId, worktreeId, leafId }) => ({
      tabId,
      worktreeId,
      title: tabId,
      activeLeafId: leafId,
      layout: null
    })),
    leaves: all.map(({ tabId, worktreeId, leafId, ptyId }) => ({
      tabId,
      worktreeId,
      leafId,
      ptyId,
      paneRuntimeId: 1
    }))
  })
  for (const { tabId, worktreeId } of tabs) {
    runtime.seedCleanupSnapshot(
      worktreeId,
      tabId,
      all.filter((entry) => entry.tabId === tabId)
    )
  }
  return { runtime, entries, other }
}
