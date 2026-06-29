const pollTimeoutMs = 2_500

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollRendererDiagnostics(read) {
  const readPromise = Promise.resolve().then(read)
  readPromise.catch(() => undefined)
  // Why: the Wayland GPU stall can freeze renderer protocol calls, so
  // diagnostics need a short deadline too.
  const result = await Promise.race([
    readPromise.then((value) => ({ timedOut: false, value })),
    delay(pollTimeoutMs).then(() => ({ timedOut: true, value: null }))
  ])
  if (result.timedOut) {
    throw new Error(`Timed out polling renderer diagnostics after ${pollTimeoutMs}ms.`)
  }
  return result.value
}

export async function collectRendererDiagnostics(page) {
  if (!page) {
    return null
  }
  try {
    return await pollRendererDiagnostics(() =>
      page.evaluate(async () => {
        const timed = (label, promise) =>
          Promise.race([
            Promise.resolve(promise).then(
              (value) => ({ value }),
              (error) => ({
                error: error instanceof Error ? error.message : String(error)
              })
            ),
            new Promise((resolve) =>
              setTimeout(() => resolve({ error: `Timed out collecting ${label}` }), 1_000)
            )
          ])
        const rectFor = (element) => {
          if (!(element instanceof Element)) {
            return null
          }
          const rect = element.getBoundingClientRect()
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        }
        const styleFor = (element) => {
          if (!(element instanceof Element)) {
            return null
          }
          const style = getComputedStyle(element)
          return {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity
          }
        }
        const store = window.__store
        const state = store?.getState?.()
        const worktreeId = state?.activeWorktreeId ?? null
        const tabId = state?.activeTabId ?? null
        const tabs = worktreeId ? (state?.tabsByWorktree?.[worktreeId] ?? []) : []
        const activeTab = tabId ? (tabs.find((tab) => tab.id === tabId) ?? null) : null
        const layout = tabId ? (state?.terminalLayoutsByTabId?.[tabId] ?? null) : null
        const tabCount = worktreeId ? (state?.tabsByWorktree?.[worktreeId]?.length ?? 0) : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const activePane = manager?.getActivePane?.() ?? null
        const paneDiagnostics = (manager?.getPanes?.() ?? []).map((pane) => {
          const xtermElement = pane.container?.querySelector?.('.xterm') ?? pane.terminal?.element
          const viewport = pane.container?.querySelector?.('.xterm-viewport') ?? null
          const buffer = pane.terminal?.buffer?.active ?? null
          return {
            paneId: pane.id ?? null,
            leafId: pane.leafId ?? null,
            isActive: activePane?.id === pane.id,
            datasetPtyId: pane.container?.dataset?.ptyId ?? null,
            terminalCols: pane.terminal?.cols ?? null,
            terminalRows: pane.terminal?.rows ?? null,
            bufferState: buffer
              ? {
                  baseY: buffer.baseY,
                  viewportY: buffer.viewportY,
                  cursorY: buffer.cursorY,
                  length: buffer.length
                }
              : null,
            containerConnected: pane.container?.isConnected ?? null,
            containerRect: rectFor(pane.container),
            containerStyle: styleFor(pane.container),
            xtermRect: rectFor(xtermElement),
            viewportRect: rectFor(viewport),
            viewportScroll: viewport
              ? {
                  scrollTop: viewport.scrollTop,
                  scrollHeight: viewport.scrollHeight,
                  clientHeight: viewport.clientHeight
                }
              : null
          }
        })
        return {
          hasStore: Boolean(store),
          workspaceSessionReady: state?.workspaceSessionReady ?? null,
          hydrationSucceeded: state?.hydrationSucceeded ?? null,
          activeRepoId: state?.activeRepoId ?? null,
          activeWorktreeId: worktreeId,
          activeWorkspaceKey: state?.activeWorkspaceKey ?? null,
          activeTabType: state?.activeTabType ?? null,
          activeTabId: tabId,
          repoIds: (state?.repos ?? []).map((repo) => repo.id),
          worktreeIdsByRepo: Object.fromEntries(
            Object.entries(state?.worktreesByRepo ?? {}).map(([id, worktrees]) => [
              id,
              worktrees.map((worktree) => worktree.id)
            ])
          ),
          tabIdsByWorktree: Object.fromEntries(
            Object.entries(state?.tabsByWorktree ?? {}).map(([id, worktreeTabs]) => [
              id,
              worktreeTabs.map((tab) => tab.id)
            ])
          ),
          tabCount,
          activeTab: activeTab
            ? {
                id: activeTab.id,
                ptyId: activeTab.ptyId ?? null,
                title: activeTab.title ?? null,
                pendingActivationSpawn: activeTab.pendingActivationSpawn ?? null
              }
            : null,
          livePtyIdsForTab: tabId ? (state?.ptyIdsByTabId?.[tabId] ?? null) : null,
          terminalLayout: layout
            ? {
                activeLeafId: layout.activeLeafId ?? null,
                expandedLeafId: layout.expandedLeafId ?? null,
                ptyIdsByLeafId: layout.ptyIdsByLeafId ?? null,
                root: layout.root ?? null
              }
            : null,
          hasPaneManager: Boolean(manager),
          paneDiagnostics,
          renderingDiagnostics: manager?.getRenderingDiagnostics?.() ?? null,
          ptyConnectDiagnostics: globalThis.__ptyConnectDiag ?? null,
          ptySessions: await timed('PTY sessions', window.api?.pty?.listSessions?.()),
          rendererDeliveryDebug: await timed(
            'renderer delivery debug',
            window.api?.pty?.getRendererDeliveryDebugSnapshot?.()
          )
        }
      })
    )
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
