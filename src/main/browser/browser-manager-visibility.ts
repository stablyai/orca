import {
  AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS,
  createNoopRestoreForTimedOutAutomationAcquire,
  isAutomationVisibilityToken,
  releaseAutomationVisibilityToken,
  resolveWithTimeout
} from './browser-manager-types'
import { BrowserManagerState } from './browser-manager-state'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  // Why: screenshots target page ids but visible chrome is keyed by workspace id; activate by workspace or the webview stays hidden and capture times out.
  async ensureWebviewVisible(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const browserWorkspaceId = this.workspaceIdByPageId.get(browserPageId) ?? browserPageId
    const worktreeId = this.worktreeIdByTabId.get(browserPageId) ?? null
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }

    const prev = await renderer
      .executeJavaScript(
        `(function() {
          var store = window.__store;
          if (!store) return null;
          var state = store.getState();
          var prevTabType = state.activeTabType;
          var prevActiveWorktreeId = state.activeWorktreeId || null;
          var prevActiveBrowserWorkspaceId = state.activeBrowserTabId || null;
          var prevActiveBrowserPageId = null;
          var prevFocusedGroupTabId = null;
          var targetWorktreeId = ${JSON.stringify(worktreeId)};
          var browserWorkspaceId = ${JSON.stringify(browserWorkspaceId)};
          var browserPageId = ${JSON.stringify(browserPageId)};
          var browserTabsByWorktree = state.browserTabsByWorktree || {};

          if (prevActiveWorktreeId) {
            var prevFocusedGroupId = (state.activeGroupIdByWorktree || {})[prevActiveWorktreeId];
            var prevGroups = (state.groupsByWorktree || {})[prevActiveWorktreeId] || [];
            for (var pg = 0; pg < prevGroups.length; pg++) {
              if (prevGroups[pg].id === prevFocusedGroupId) {
                prevFocusedGroupTabId = prevGroups[pg].activeTabId;
                break;
              }
            }
          }

          if (prevActiveBrowserWorkspaceId) {
            for (var prevWtId in browserTabsByWorktree) {
              var prevBrowserTabs = browserTabsByWorktree[prevWtId] || [];
              for (var pbt = 0; pbt < prevBrowserTabs.length; pbt++) {
                if (prevBrowserTabs[pbt].id === prevActiveBrowserWorkspaceId) {
                  prevActiveBrowserPageId = prevBrowserTabs[pbt].activePageId || null;
                  break;
                }
              }
              if (prevActiveBrowserPageId) break;
            }
          }

          if (
            targetWorktreeId &&
            prevActiveWorktreeId !== targetWorktreeId &&
            typeof state.setActiveWorktree === 'function'
          ) {
            state.setActiveWorktree(targetWorktreeId);
            state = store.getState();
          }

          var foundWorkspace = null;
          for (var wtId in browserTabsByWorktree) {
            var tabs = browserTabsByWorktree[wtId] || [];
            for (var i = 0; i < tabs.length; i++) {
              if (tabs[i].id === browserWorkspaceId) {
                foundWorkspace = tabs[i];
                if (!targetWorktreeId) {
                  targetWorktreeId = wtId;
                }
                break;
              }
            }
            if (foundWorkspace) break;
          }

          var hasTargetPage = false;
          var targetPages = (state.browserPagesByWorkspace || {})[browserWorkspaceId] || [];
          for (var pageIndex = 0; pageIndex < targetPages.length; pageIndex++) {
            if (targetPages[pageIndex].id === browserPageId) {
              hasTargetPage = true;
              break;
            }
          }

          if (foundWorkspace) {
            if (typeof state.setActiveBrowserTab === 'function') {
              state.setActiveBrowserTab(browserWorkspaceId);
              state = store.getState();
            } else {
              var allTabs = state.unifiedTabsByWorktree || {};
              var found = null;
              for (var unifiedWtId in allTabs) {
                var unifiedTabs = allTabs[unifiedWtId] || [];
                for (var unifiedIndex = 0; unifiedIndex < unifiedTabs.length; unifiedIndex++) {
                  if (
                    unifiedTabs[unifiedIndex].contentType === 'browser' &&
                    unifiedTabs[unifiedIndex].entityId === browserWorkspaceId
                  ) {
                    found = unifiedTabs[unifiedIndex];
                    break;
                  }
                }
                if (found) break;
              }
              if (found) {
                state.activateTab(found.id);
              }
              state.setActiveTabType('browser');
              state = store.getState();
            }
            // Why: activating the workspace alone is not enough for screenshot
            // capture when a browser workspace contains multiple pages. The
            // compositor only paints the currently mounted page guest.
            if (
              hasTargetPage &&
              foundWorkspace.activePageId !== browserPageId &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              state.setActiveBrowserPage(browserWorkspaceId, browserPageId);
              state = store.getState();
            }
          }

          return {
            prevTabType: prevTabType,
            prevActiveWorktreeId: prevActiveWorktreeId,
            prevActiveBrowserWorkspaceId: prevActiveBrowserWorkspaceId,
            prevActiveBrowserPageId: prevActiveBrowserPageId,
            prevFocusedGroupTabId: prevFocusedGroupTabId,
            targetWorktreeId: targetWorktreeId,
            targetBrowserWorkspaceId: foundWorkspace ? browserWorkspaceId : null,
            targetBrowserPageId: foundWorkspace && hasTargetPage ? browserPageId : null
          };
        })()`
      )
      .catch(() => null)

    const needsRestore =
      prev &&
      (prev.prevTabType !== 'browser' ||
        prev.prevActiveWorktreeId !== prev.targetWorktreeId ||
        prev.prevFocusedGroupTabId !== null ||
        prev.prevActiveBrowserWorkspaceId !== prev.targetBrowserWorkspaceId ||
        prev.prevActiveBrowserPageId !== prev.targetBrowserPageId)

    if (!needsRestore) {
      return () => {}
    }

    return () => {
      if (!prev || !renderer || renderer.isDestroyed()) {
        return
      }
      renderer
        .executeJavaScript(
          `(function() {
            var store = window.__store;
            if (!store) return;
            var state = store.getState();
            if (
              ${JSON.stringify(prev?.prevActiveWorktreeId)} &&
              ${JSON.stringify(prev?.prevActiveWorktreeId)} !==
                ${JSON.stringify(prev?.targetWorktreeId)} &&
              typeof state.setActiveWorktree === 'function'
            ) {
              state.setActiveWorktree(${JSON.stringify(prev?.prevActiveWorktreeId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} !==
                ${JSON.stringify(prev?.targetBrowserWorkspaceId)} &&
              typeof state.setActiveBrowserTab === 'function'
            ) {
              state.setActiveBrowserTab(${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} !==
                ${JSON.stringify(prev?.targetBrowserPageId)} &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              // Why: Orca remembers the last browser workspace/page even when
              // the user is currently in terminal/editor view. Screenshot prep
              // temporarily switches that hidden browser selection state, so
              // restore it independently of the visible tab type.
              state.setActiveBrowserPage(
                ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)},
                ${JSON.stringify(prev?.prevActiveBrowserPageId)}
              );
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevTabType)} !== 'browser' &&
              ${JSON.stringify(prev?.prevFocusedGroupTabId)}
            ) {
              state.activateTab(${JSON.stringify(prev?.prevFocusedGroupTabId)});
            }
            if (${JSON.stringify(prev?.prevTabType)} !== 'browser') {
              state.setActiveTabType(${JSON.stringify(prev?.prevTabType)});
            }
          })()`
        )
        .catch(() => {})
    }
  }

  async acquireAutomationVisibility(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }

    // Why: agent commands need a paintable webview for lazy-loading sites without stealing the user's visible tab.
    const acquirePromise = renderer
      .executeJavaScript(
        `(async function() {
            var bridge = window.__orcaBrowserAutomationVisibility;
            if (!bridge || typeof bridge.acquire !== 'function') return null;
            return await bridge.acquire(${JSON.stringify(browserPageId)});
          })()`
      )
      .catch(() => null)
    const { value: token, timedOut } = await resolveWithTimeout(
      acquirePromise,
      AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS,
      null
    )

    if (!isAutomationVisibilityToken(token)) {
      return createNoopRestoreForTimedOutAutomationAcquire(renderer, acquirePromise, timedOut)
    }

    return () => {
      releaseAutomationVisibilityToken(renderer, token)
    }
  }
}
