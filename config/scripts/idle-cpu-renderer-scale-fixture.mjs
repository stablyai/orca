export async function configureRendererScaleFixture(page, options, repoPath) {
  return page.evaluate(
    ({ agentsPerWorktree, lineageDepth, repoPath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const normalizePath = (value) =>
        String(value ?? '')
          .replaceAll('\\', '/')
          .toLowerCase()
      const primaryPath = normalizePath(repoPath)
      const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
      const state = store.getState()
      const worktrees = Object.values(state.worktreesByRepo)
        .flat()
        .filter((worktree) => !worktree.isArchived)
        .sort((left, right) => {
          const primaryOrder =
            Number(normalizePath(right.path) === primaryPath) -
            Number(normalizePath(left.path) === primaryPath)
          return (
            primaryOrder ||
            compare(normalizePath(left.path), normalizePath(right.path)) ||
            compare(left.id, right.id)
          )
        })
      const appliedLineageDepth = Math.min(lineageDepth, Math.max(0, worktrees.length - 1))
      if (lineageDepth === 0 && agentsPerWorktree === 0) {
        return {
          applied: false,
          requestedLineageDepth: lineageDepth,
          appliedLineageDepth,
          agentsPerWorktree,
          seededAgentRows: 0
        }
      }

      state.setActiveView('terminal')
      state.setSidebarOpen(true)
      state.setGroupBy('none')
      state.setSortBy('recent')
      state.setShowActiveOnly(false)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])

      const lineageById = { ...store.getState().worktreeLineageById }
      const lineageParentIds = new Set()
      if (appliedLineageDepth > 0) {
        for (const worktree of worktrees) {
          delete lineageById[worktree.id]
          if (!worktree.instanceId) {
            throw new Error(`Worktree ${worktree.id} has no instanceId for lineage seeding`)
          }
        }
        for (let index = 1; index < worktrees.length; index += 1) {
          const child = worktrees[index]
          const parent = worktrees[Math.min(index - 1, appliedLineageDepth - 1)]
          lineageParentIds.add(parent.id)
          lineageById[child.id] = {
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId,
            parentWorktreeId: parent.id,
            parentWorktreeInstanceId: parent.instanceId,
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1_700_000_000_000 + index
          }
        }
      }
      const collapsedGroups = new Set(store.getState().collapsedGroups)
      for (const parentId of lineageParentIds) {
        collapsedGroups.delete(`lineage:${parentId}`)
      }
      store.setState({ worktreeLineageById: lineageById, collapsedGroups })

      let seededAgentRows = 0
      if (agentsPerWorktree > 0) {
        store.getState().setWorktreeCardMode('Default')
        store.getState().setAgentActivityDisplayMode('full')
        const fixtureNow = Date.now()
        worktrees.forEach((worktree, worktreeIndex) => {
          const next = store.getState()
          const tab =
            next.tabsByWorktree[worktree.id]?.[0] ??
            next.createTab(worktree.id, undefined, undefined, {
              activate: false,
              id: `idle-cpu-tab-${worktreeIndex}`
            })
          for (let agentIndex = 0; agentIndex < agentsPerWorktree; agentIndex += 1) {
            const agentType = agentIndex % 2 === 0 ? 'codex' : 'claude'
            const leafSequence =
              BigInt(worktreeIndex) * BigInt(agentsPerWorktree) + BigInt(agentIndex + 1)
            const leafId = `00000000-0000-4000-8000-${leafSequence.toString(16).padStart(12, '0')}`
            store.getState().setAgentStatus(
              `${tab.id}:${leafId}`,
              {
                state: 'working',
                prompt: `Idle CPU agent ${worktreeIndex + 1}.${agentIndex + 1}`,
                agentType
              },
              agentType,
              { updatedAt: fixtureNow, stateStartedAt: fixtureNow },
              { tabId: tab.id, worktreeId: worktree.id }
            )
            seededAgentRows += 1
          }
        })
      }
      return {
        applied: true,
        requestedLineageDepth: lineageDepth,
        appliedLineageDepth,
        lineageEdges: appliedLineageDepth > 0 ? Math.max(0, worktrees.length - 1) : 0,
        expandedLineageGroups: lineageParentIds.size,
        agentsPerWorktree,
        seededAgentRows,
        orderedWorktreeIds: worktrees.map((worktree) => worktree.id)
      }
    },
    { agentsPerWorktree: options.agentsPerWorktree, lineageDepth: options.lineageDepth, repoPath }
  )
}

export async function collectRendererCensus(page, configuredLineageDepth) {
  return page.evaluate((configuredDepth) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const worktreeIds = new Set(worktrees.map((worktree) => worktree.id))
    const lineageDepthById = new Map()
    const getDepth = (worktreeId, trail = new Set()) => {
      if (lineageDepthById.has(worktreeId)) {
        return lineageDepthById.get(worktreeId)
      }
      const lineage = state.worktreeLineageById[worktreeId]
      if (!lineage || !worktreeIds.has(lineage.parentWorktreeId) || trail.has(worktreeId)) {
        return 0
      }
      const nextTrail = new Set(trail)
      nextTrail.add(worktreeId)
      const depth = 1 + getDepth(lineage.parentWorktreeId, nextTrail)
      lineageDepthById.set(worktreeId, depth)
      return depth
    }
    const logicalDepths = worktrees.map((worktree) => getDepth(worktree.id))
    const lineageParentIds = new Set(
      Object.values(state.worktreeLineageById)
        .filter((lineage) => worktreeIds.has(lineage.worktreeId))
        .map((lineage) => lineage.parentWorktreeId)
    )
    const sidebar = document.querySelector('[data-worktree-sidebar]')
    const mountedWorktreeIds = [
      ...new Set(
        [...(sidebar?.querySelectorAll('[data-worktree-id]') ?? [])]
          .map((element) => element.getAttribute('data-worktree-id'))
          .filter(Boolean)
      )
    ]
    const mountedAgentRows = [...(sidebar?.querySelectorAll('*') ?? [])].filter(
      (element) =>
        element.classList.contains('group/agent-row') ||
        element.classList.contains('compact-agent-row')
    ).length
    let diagnosticCensus = null
    try {
      diagnosticCensus = window.__orcaTypingDiagnostic?.report().census ?? null
    } catch {}
    const collapsedLineageGroups = [...lineageParentIds].filter((parentId) =>
      state.collapsedGroups.has(`lineage:${parentId}`)
    ).length
    return {
      capturedAt: new Date().toISOString(),
      worktrees: {
        store: worktrees.length,
        mountedCards: sidebar?.querySelectorAll('[data-worktree-card-surface]').length ?? 0,
        mountedUnique: mountedWorktreeIds.length,
        mountedIds: mountedWorktreeIds.slice(0, 100),
        mountedIdsTruncated: Math.max(0, mountedWorktreeIds.length - 100)
      },
      agentRows: {
        storeLive: Object.keys(state.agentStatusByPaneKey ?? {}).length,
        storeRetained: Object.keys(state.retainedAgentsByPaneKey ?? {}).length,
        mounted: mountedAgentRows,
        diagnosticMounted: diagnosticCensus?.agentRows.mountedDom ?? null
      },
      storeListeners: diagnosticCensus?.storeListeners ?? null,
      lineage: {
        configuredDepth,
        measuredMaxDepth: Math.max(0, ...logicalDepths),
        edges: logicalDepths.filter((depth) => depth > 0).length,
        groups: lineageParentIds.size,
        expandedGroups: lineageParentIds.size - collapsedLineageGroups,
        collapsedGroups: collapsedLineageGroups
      },
      diagnostic: diagnosticCensus
    }
  }, configuredLineageDepth)
}
