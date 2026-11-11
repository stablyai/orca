import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import { RetainedTerminalSessionIndex } from '../surface/retained-terminal-session-index'
import * as paneTree from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WORKTREE,
  openTopologyStore
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
const { OrcaRuntimeService } = await import('../../orca-runtime')

class RetainedRuntime extends OrcaRuntimeService {
  remember(start: RetainedTerminalStart): void {
    this.paneStartStatuses.set(`${start.tabId}:${start.leafId}`, {
      status: start.status,
      retainedTerminalStart: start
    })
  }
  hasFact(start: RetainedTerminalStart): boolean {
    return this.paneStartStatuses.peek(`${start.tabId}:${start.leafId}`) !== null
  }
}

const leafOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

it.each([300, 3000])(
  'retires retained facts on real Store topology writes without walking %i facts on scalar writes',
  async (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-retained-start-store-'))
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    const session = new WindowSession(getDefaultWorkspaceSession())
    const starts: RetainedTerminalStart[] = []
    for (let i = 0; i < count; i += 1) {
      const tabId = `retained-${i}`
      const leafId = leafOf(i)
      session.addTab(WORKTREE, tabId, leafId)
      starts.push({
        worktreeId: WORKTREE,
        runtimeId: 'runtime',
        executionHostId: 'local',
        tabId,
        leafId,
        bindingGeneration: 0,
        startSequence: i + 1,
        status: 'failed',
        reason: 'Shell could not start.'
      })
    }
    store.setWorkspaceSession(session.snapshot())
    let tabReads = 0
    // Count owner reads after Store normalization, which has its own unchanged cost.
    const detachCounter = store.onWorkspaceSessionWritten(() => {
      const tabs = store.getWorkspaceSession().tabsByWorktree[WORKTREE] ?? []
      for (let i = 0; i < tabs.length; i += 1) {
        let row = tabs[i]!
        Object.defineProperty(tabs, i, {
          configurable: true,
          enumerable: true,
          get: () => {
            tabReads += 1
            return row
          },
          set: (next) => {
            row = next
          }
        })
      }
      tabReads = 0
    })
    const runtime = new RetainedRuntime(store)
    const visits = vi.spyOn(RetainedTerminalSessionIndex.prototype, 'isCurrent')
    const traversals = vi.spyOn(paneTree, 'collectLeafIds')
    try {
      for (const start of starts) {
        runtime.remember(start)
      }
      visits.mockClear()
      traversals.mockClear()
      store.patchWorkspaceSession({ activeWorktreeId: WORKTREE })
      store.patchWorkspaceSession({ activeTabId: 'retained-1' })
      expect(visits).not.toHaveBeenCalled()
      expect(traversals).not.toHaveBeenCalled()

      // Full replacement may inspect each affected fact once, sharing tab and leaf indices.
      store.setWorkspaceSession(structuredClone(store.getWorkspaceSession()))
      expect(tabReads).toBeLessThanOrEqual(count)
      expect(visits.mock.calls.length).toBeLessThanOrEqual(count)
      expect(traversals.mock.calls.length).toBeLessThanOrEqual(count)
      expect(starts.every((start) => runtime.hasFact(start))).toBe(true)

      const current = store.getWorkspaceSession()
      const first = starts[0]!
      const layout = current.terminalLayoutsByTabId[first.tabId]!
      store.patchWorkspaceSession({
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          [first.tabId]: { ...layout, ptyIdsByLeafId: { [first.leafId]: 'accepted-pty' } }
        },
        terminalPtyIncarnationsByPaneKey: {
          [`${first.tabId}:${first.leafId}`]: 'accepted-incarnation'
        }
      })
      expect(runtime.hasFact(first)).toBe(false)
      expect(runtime.hasFact(starts[1]!)).toBe(true)
      const afterBind = store.getWorkspaceSession()
      const second = starts[1]!
      store.patchWorkspaceSession({
        tabsByWorktree: {
          ...afterBind.tabsByWorktree,
          [WORKTREE]: afterBind.tabsByWorktree[WORKTREE]!.filter((tab) => tab.id !== second.tabId)
        }
      })
      expect(runtime.hasFact(second)).toBe(false)
      expect(runtime.hasFact(starts[2]!)).toBe(true)

      runtime.disposeRetainedTerminalStarts()
      visits.mockClear()
      store.patchWorkspaceSession({ activeTabId: 'retained-2' })
      expect(visits).not.toHaveBeenCalled()
    } finally {
      runtime.disposeRetainedTerminalStarts()
      detachCounter()
      visits.mockRestore()
      traversals.mockRestore()
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
