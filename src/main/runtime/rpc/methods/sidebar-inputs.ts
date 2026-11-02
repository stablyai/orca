import { defineMethod } from '../core'
import { requireSwitchedOn } from '../../sidebar-inputs/require-switched-on'
import { readRuntimeDesktopSidebarFacts } from '../../sidebar-inputs/sidebar-inputs-feed-domains'
import { isHostOwnPhone } from '../host-own-phone'
import { SidebarInputsReadParams } from '../../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import { SidebarSessionBeginParams } from '../../../../shared/rpc-contract/sidebar-session-params'
import { RepoIconDataUrlsParams } from '../../../../shared/sidebar-list/repo-icon-data-urls-contract'
import { SetCollapsedParams } from '../../../../shared/rpc-contract/workspace-view-collapse-params'
import { setCollapsedSection } from '../../workspace-view-collapse-writes'

// Registered only with ORCA_SIDEBAR_INPUTS=main, so the producers below always exist.

export const SIDEBAR_INPUT_METHODS = [
  defineMethod({
    name: 'sidebarInputs.activityFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.sidebarFacts).getWorkspaceActivityFacts()
  }),
  defineMethod({
    name: 'sidebarInputs.repoIcons',
    permission: 'workspace',
    params: RepoIconDataUrlsParams,
    handler: async ({ ids }, { runtime }) => requireSwitchedOn(runtime.repoIconDataUrls).read(ids)
  }),
  defineMethod({
    name: 'sidebarInputs.desktopFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => readRuntimeDesktopSidebarFacts(runtime.requireStore())
  }),
  defineMethod({
    name: 'sidebarInputs.pairedServerRows',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => requireSwitchedOn(runtime.pairedServerRows).snapshot()
  }),
  defineMethod({
    name: 'sidebarInputs.workspaceRows',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => requireSwitchedOn(runtime.workspaceRows).snapshot()
  }),
  defineMethod({
    name: 'sidebarInputs.reviewFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.sidebarFacts).getWorkspaceReviewFacts()
  }),
  defineMethod({
    name: 'sidebarInputs.temporal',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.sidebarFacts).getSidebarTemporalSnapshot()
  }),
  defineMethod({
    name: 'sidebarInputs.read',
    permission: 'workspace',
    params: SidebarInputsReadParams,
    // The feed is this host's own view. A delegated phone lists through its own desktop's feed,
    // which carries this host's rows; other desktops and web clients build their own view.
    handler: async (params, context) => {
      const feed = requireSwitchedOn(context.runtime.sidebarInputsFeed)
      const { connectionId } = context
      if (!isHostOwnPhone(context) || connectionId === undefined) {
        throw Object.assign(new Error('Only this host’s own phone reads its sidebar feed.'), {
          code: 'forbidden'
        })
      }
      // A connection already closed has run its cleanups; subscribing it now would never release.
      if (context.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      // Subscribed from a connection's first read until it closes.
      if (feed.acquire(connectionId)) {
        context.runtime.registerSubscriptionCleanup(
          `sidebar-inputs-feed-${connectionId}`,
          () => feed.release(connectionId),
          connectionId
        )
      }
      return feed.read(params)
    }
  }),
  defineMethod({
    name: 'sidebarSession.begin',
    permission: 'workspace',
    params: SidebarSessionBeginParams,
    handler: async ({ sessionId }, { runtime }) => {
      requireSwitchedOn(runtime.sidebarFacts).beginSidebarListSession(sessionId)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'sidebarInputs.workspaceCreations',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.workspaceCreations).snapshot()
  }),
  defineMethod({
    name: 'ui.setCollapsed',
    permission: 'workspace',
    params: SetCollapsedParams,
    // Why the same callers as ui.set: collapsedGroups is not pairing-local, so both writes share one view.
    handler: (params, { runtime }) =>
      setCollapsedSection(runtime, requireSwitchedOn(runtime.collapseWriteOrder), params)
  })
]
