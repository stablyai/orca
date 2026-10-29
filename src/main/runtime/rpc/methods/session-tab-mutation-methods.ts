import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { commitLeafMoveAndRekey } from '../../../ipc/pty/ipc/leaf-move'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { MovedPanePlacement } from '../../session-tabs/headless-pane-move-to-new-tab'
import { defineMethod } from '../core'
import {
  assertProjectedSessionTabVisible,
  translateProjectedSessionTabMove
} from './session-tab-browser-placement-projection'
import { projectSessionTabsForClient } from './session-tabs-inventory'
import {
  ActivateTab,
  MovePaneToNewTab,
  MoveTab,
  SetTabProps,
  UpdatePaneLayout
} from '../../../../shared/rpc-contract/session-tabs-schemas-params'

export const SESSION_TAB_MUTATION_METHODS = [
  defineMethod({
    name: 'session.tabs.activate',
    permission: 'workspace',
    params: ActivateTab,
    handler: async (params, { runtime, clientKind, pairedDeviceId, clientCapabilities }) => {
      if (clientKind) {
        const visible = projectSessionTabsForClient(
          await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId),
          clientKind,
          clientCapabilities
        )
        assertProjectedSessionTabVisible(visible, params.tabId)
      }
      const result = await runtime.activateMobileSessionTab(
        params.worktree,
        params.tabId,
        params.leafId,
        {
          notifyClients: params.notifyClients !== false,
          clientNavigationId: pairedDeviceId,
          ...(params.intent ? { intent: params.intent } : {}),
          navigation: resolveRuntimeNavigationTarget({
            navigation: params.navigation,
            notifyClients: params.notifyClients,
            clientKind
          })
        }
      )
      const projected = projectSessionTabsForMutationClient(result, clientKind, clientCapabilities)
      // One reply's answer, outside the projection: the fallback is never part of the tab snapshot.
      return result.startupCwdFallback
        ? { ...projected, startupCwdFallback: result.startupCwdFallback }
        : projected
    }
  }),
  defineMethod({
    name: 'session.tabs.move',
    permission: 'workspace',
    params: MoveTab,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      let translated: Parameters<typeof translateProjectedSessionTabMove>[2] = params
      if (clientKind) {
        const raw = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
        const projected = projectSessionTabsForClient(raw, clientKind, clientCapabilities)
        translated = translateProjectedSessionTabMove(raw, projected, params)
      }
      const base = { tabId: translated.tabId, targetGroupId: translated.targetGroupId }
      if (translated.kind === 'reorder') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'reorder',
          tabOrder: translated.tabOrder
        })
      }
      if (translated.kind === 'split') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'split',
          splitDirection: translated.splitDirection
        })
      }
      return runtime.moveMobileSessionTab(params.worktree, {
        ...base,
        kind: 'move-to-group',
        index: translated.index
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.updatePaneLayout',
    permission: 'workspace',
    params: UpdatePaneLayout,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      await assertVisibleMutationTab(
        runtime,
        params.worktree,
        params.tabId,
        pairedDeviceId,
        clientKind,
        clientCapabilities
      )
      return runtime.updateMobileSessionPaneLayout(params.worktree, {
        tabId: params.tabId,
        root: params.root,
        expandedLeafId: params.expandedLeafId ?? null,
        chatLeafId: params.chatLeafId,
        titlesByLeafId: params.titlesByLeafId,
        renamedLeafIds: params.renamedLeafIds
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.movePaneToNewTab',
    permission: 'workspace',
    params: MovePaneToNewTab,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      await assertVisibleMutationTab(
        runtime,
        params.worktree,
        params.sourceTabId,
        pairedDeviceId,
        clientKind,
        clientCapabilities
      )
      return runtime.moveMobileSessionLeafToNewTab(
        params.worktree,
        {
          sourceTabId: params.sourceTabId,
          targetTabId: params.targetTabId,
          leafId: params.leafId
        },
        (move) => commitLeafMoveAndRekey({ store: runtime.requireStore(), runtime }, move),
        await resolveMovedPanePlacement(
          runtime,
          params,
          pairedDeviceId,
          clientKind,
          clientCapabilities
        )
      )
    }
  }),
  defineMethod({
    name: 'session.tabs.setTabProps',
    permission: 'workspace',
    params: SetTabProps,
    handler: async (params, { runtime, pairedDeviceId, clientCapabilities, clientKind }) => {
      await assertVisibleMutationTab(
        runtime,
        params.worktree,
        params.tabId,
        pairedDeviceId,
        clientKind,
        clientCapabilities
      )
      return runtime.setMobileSessionTabProps(params.worktree, {
        tabId: params.tabId,
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
        ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {}),
        ...(params.customTitle !== undefined ? { customTitle: params.customTitle } : {})
      })
    }
  })
]

/**
 * The drop position in the host's own order: a client's index counts only the tabs it is shown, as
 * `session.tabs.move` translates it. A group the client cannot name leaves the tab appended.
 */
async function resolveMovedPanePlacement(
  runtime: OrcaRuntimeService,
  params: { worktree: string; sourceTabId: string; targetGroupId?: string; index?: number },
  pairedDeviceId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabsForClient>[2]
): Promise<MovedPanePlacement | undefined> {
  const { targetGroupId, index } = params
  if (!targetGroupId) {
    return undefined
  }
  if (!clientKind || index === undefined) {
    return { targetGroupId, ...(index !== undefined ? { index } : {}) }
  }
  const raw = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
  try {
    // The new tab does not exist yet, so its source tab stands in for it; only the index is read.
    const translated = translateProjectedSessionTabMove(
      raw,
      projectSessionTabsForClient(raw, clientKind, clientCapabilities),
      { kind: 'move-to-group', tabId: params.sourceTabId, targetGroupId, index }
    )
    return translated.kind === 'move-to-group' && translated.index !== undefined
      ? { targetGroupId, index: translated.index }
      : { targetGroupId }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'target_group_not_found' || error.message === 'invalid_tab_order')
    ) {
      return undefined
    }
    throw error
  }
}

const projectSessionTabsForMutationClient = projectSessionTabsForClient

async function assertVisibleMutationTab(
  runtime: OrcaRuntimeService,
  worktree: string,
  tabId: string,
  pairedDeviceId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabsForClient>[2]
): Promise<void> {
  if (!clientKind) {
    return
  }
  const visible = projectSessionTabsForClient(
    await runtime.listMobileSessionTabs(worktree, pairedDeviceId),
    clientKind,
    clientCapabilities
  )
  assertProjectedSessionTabVisible(visible, tabId)
}
