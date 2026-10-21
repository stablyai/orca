import { vi } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLateExitHarness } from '../../../src/main/ipc/pty/daemon-late-exit-test-fixture'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { Store } from '../../../src/main/persistence/loading-store/store'
import { resolveStablePaneOwner } from '../../../src/main/ipc/pty/pane/stable-owner'
import {
  registerRuntimeTerminalTab,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from '../../../src/renderer/src/runtime/sync-runtime-graph'
import { graphState } from '../../../src/renderer/src/runtime/sync-runtime-graph/graph-state'
import { syncRuntimeGraph } from '../../../src/renderer/src/runtime/sync-runtime-graph/graph-publication'
import { makeState } from '../../../src/renderer/src/runtime/sync-runtime-graph-test-harness'
import { advertisedUrlWatcher } from '../../../src/main/ports/advertised-url-watcher'

class QueuedGraphExitRuntime extends OrcaRuntimeService {
  capture(id: string) {
    const pty = this.ptysById.get(id)
    return {
      connected: pty?.connected,
      exitCause: pty?.lastExitCause,
      incarnationId: pty?.incarnationId,
      liveness: this.getPtyLivenessVerdict(id),
      model: this.headlessTerminals.has(id),
      urlBound: advertisedUrlWatcher['ptyToWorktree'].has(id),
      leaves: this.getLeavesForPty(id).map((leaf) => ({
        connected: leaf.connected,
        writable: leaf.writable
      }))
    }
  }

  mobile(worktreeId: string) {
    return this.getMobileSessionTabsForWorktree(worktreeId).tabs.flatMap((tab) =>
      tab.type === 'terminal'
        ? [
            {
              ptyId: tab.ptyId,
              handlePtyId: tab.terminal ? this.handles.get(tab.terminal)?.ptyId : null
            }
          ]
        : []
    )
  }
}
export async function runQueuedGraphExitScenario(
  replacement: boolean,
  graphGapBeforeInventory = false
) {
  const h = await startLateExitHarness()
  const predecessor = h.subprocess
  const dir = mkdtempSync(join(tmpdir(), 'orca-queued-owner-'))
  const store = new Store({ dataFile: join(dir, 'orca-data.json') })
  const runtime = new QueuedGraphExitRuntime(store)
  h.session.runtime = runtime
  const WT = 'repo::/tmp/late-exit-audit'
  const TAB = '00000000-0000-4000-8000-000000000001'
  const LEAF = '00000000-0000-4000-8000-000000000002'
  const successorId = `${WT}@@successor`
  let unregister: (() => void) | undefined
  try {
    store.persistPtyBinding({
      worktreeId: WT,
      tabId: TAB,
      leafId: LEAF,
      ptyId: h.id,
      incarnationId: h.result.incarnationId
    })
    runtime.registerPty(h.id, WT, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: h.result.incarnationId
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: (_connection, opts) => h.adapter.listProcesses(opts),
      hasPty: (id) => h.adapter.hasPty(id)
    })
    const state = makeState({
      tabsByWorktree: {
        [WT]: [
          {
            id: TAB,
            worktreeId: WT,
            title: 'Terminal',
            ptyId: h.id,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: h.id }
        }
      }
    })
    const manager = {
      getPanes: () => [{ id: 1, leafId: LEAF }],
      getActivePane: () => ({ id: 1, leafId: LEAF }),
      getLeafId: () => LEAF,
      getNumericIdForLeaf: () => 1
    }
    setRuntimeGraphSyncEnabled(false)
    setRuntimeGraphStoreStateGetter(() => state)
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    let deliver: (() => void) | undefined
    let capture: unknown
    let queue = false
    vi.stubGlobal('window', {
      api: {
        runtime: {
          syncWindowGraph: (graph: never) => {
            if (!queue) {
              return Promise.resolve(runtime.syncWindowGraph(1, graph))
            }
            capture = structuredClone(graph)
            return new Promise((resolve) => {
              deliver = () => resolve(runtime.syncWindowGraph(1, graph))
            })
          }
        }
      }
    })
    const mount = () =>
      registerRuntimeTerminalTab({
        tabId: TAB,
        worktreeId: WT,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only the four pane lookup methods supplied by this headless manager.
        getManager: () => manager as never,
        getContainer: () => null,
        getPtyIdForPane: () => h.id,
        getTabWideAgentHintLeafId: () => null
      })
    unregister = mount()
    const publish = (): Promise<void> => {
      graphState.syncEnabled = true
      const pending = syncRuntimeGraph()
      graphState.syncEnabled = false
      return pending
    }
    await publish()
    queue = true
    const inFlight = publish()
    assert(deliver, 'Publisher did not dispatch its graph')
    if (replacement) {
      const next = await h.adapter.spawn({ cols: 80, rows: 24, sessionId: successorId })
      assert(
        store.persistPtyBinding({
          worktreeId: WT,
          tabId: TAB,
          leafId: LEAF,
          ptyId: next.id,
          incarnationId: next.incarnationId
        })
      )
      runtime.registerPty(next.id, WT, null, {
        tabId: TAB,
        leafId: LEAF,
        incarnationId: next.incarnationId
      })
    }
    predecessor._simulateExit(0)
    await h.waitForExit()
    const afterExit = runtime.capture(h.id)
    assert.equal(afterExit.connected, false)
    deliver()
    await inFlight
    const afterQueuedGraph = runtime.capture(h.id)
    let resolution: unknown
    try {
      resolution = resolveStablePaneOwner(runtime, store, `${TAB}:${LEAF}`, WT, null)
    } catch (e) {
      resolution = e instanceof Error ? e.message : String(e)
    }
    queue = false
    if (graphGapBeforeInventory) {
      unregister()
      unregister = undefined
      await publish()
    }
    const list = await runtime.listTerminals()
    const afterFreshList = runtime.capture(h.id)
    if (graphGapBeforeInventory) {
      unregister = mount()
    }
    await publish()
    return {
      scenario: replacement ? 'successor-binding-before-exit' : 'ordinary-exit',
      graphGapBeforeInventory,
      capture,
      afterExit,
      afterQueuedGraph,
      afterFreshList,
      afterRepeatedGraph: runtime.capture(h.id),
      mobile: runtime.mobile(WT),
      resolution,
      inventory: await h.adapter.listProcesses(),
      persistedPtyId:
        store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEAF],
      listed: list.terminals.map((t) => ({
        id: t.ptyId,
        connected: t.connected,
        tabId: t.tabId,
        leafId: t.leafId
      }))
    }
  } finally {
    graphState.syncEnabled = false
    unregister?.()
    setRuntimeGraphSyncEnabled(false)
    setRuntimeGraphStoreStateGetter(null)
    vi.unstubAllGlobals()
    runtime.onPtyExit(h.id, 0)
    runtime.onPtyExit(successorId, 0)
    await h.dispose()
    store.flushOrThrow()
    rmSync(dir, { recursive: true, force: true })
  }
}
