import { RUNTIME_CAPABILITIES } from '../../../../../shared/protocol-version'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../../../../shared/workspace-layout/layout-intents-capability'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

import type { ExecutionHostId } from '../../../../../shared/execution-host'

import type { LayoutApplyOutcome } from '../../../../../shared/workspace-layout/workspace-layout-command-types'

import type { Tab } from '../../../../../shared/tab-types'

import type { RuntimeStore } from '../../../construction/runtime-store-contract'

import '../../../../../shared/workspace-layout/workspace-layout-client-visibility'
import '../../server/runtime-rpc-mobile-method-allowlist'
import { OrcaRuntimeService } from '../../../orca-runtime'

import '../../core'
import './workspace-layout'
import '../rpc-method-registry'
import {
  partialRuntimeStore,
  type PartialRuntimeStore
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

// Pin a window-owned build even under `ORCA_LAYOUT_OWNER=main`, so the default registry omits layout commands.
vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const frozen = vi.hoisted(() => ({ workspaces: new Set<string>() }))
vi.mock(
  '../../../../persistence/moving-wsl-projects/wsl-move-scope-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isWslMoveWorkspaceSessionFrozen: (workspace: string) => frozen.workspaces.has(workspace)
  })
)

const WORKTREE = 'repo-1::/work/one'
const SPLIT = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical'
} as const

function sessionListing(tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE,
    activeTabId: tabId,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

afterEach(() => {
  frozen.workspaces.clear()
})

describe('layout.apply', () => {
  it('does not advertise layout mutations in a window-owned build', () => {
    expect(RUNTIME_CAPABILITIES).not.toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).not.toContain(LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
  })

  it('gives each title in its tab’s partition in one write, naming a paired server’s tab', async () => {
    const applyTabRenames = vi.fn<NonNullable<RuntimeStore['applyTabRenames']>>(async (batches) => [
      { rename: batches[0]!.renames[0]!, code: 'tab_not_found' }
    ])
    const hosts: Record<string, string> = { 'tab-1': 'local', 'tab-2': 'ssh:target-1' }
    const store: PartialRuntimeStore = {
      getRepo: () => undefined,
      getWorkspaceSessionHostIds: () => ['local', 'ssh:target-1', 'runtime:env-1'],
      getWorkspaceSession: (host: string) => ({
        ...sessionListing('other'),
        tabsByWorktree: {},
        unifiedTabs: {
          [WORKTREE]: Object.entries({ ...hosts, 'tab-3': 'runtime:env-1' })
            .filter(([, owner]) => owner === host)
            .map(([id]): Tab => ({
              id,
              entityId: id,
              groupId: 'group-1',
              worktreeId: WORKTREE,
              contentType: 'terminal',
              label: id,
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }))
        }
      }),
      applyTabRenames
    }
    const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
    const titled = (tabId: string) => ({ workspace: WORKTREE, tabId, title: `Title ${tabId}` })

    const reply = await runtime.applyLayoutCommand({
      type: 'renameTabs',
      kind: 'generated',
      renames: [titled('tab-1'), titled('tab-2'), titled('tab-3')]
    })

    const renameOf = (tabId: string) => ({ type: 'renameTab', kind: 'generated', ...titled(tabId) })
    expect(applyTabRenames).toHaveBeenCalledTimes(1)
    expect(applyTabRenames).toHaveBeenCalledWith([
      { hostId: 'local', renames: [renameOf('tab-1')] },
      { hostId: 'ssh:target-1', renames: [renameOf('tab-2')] }
    ])
    expect(reply).toEqual({
      ok: true,
      result: {
        untitled: [
          { workspace: WORKTREE, tabId: 'tab-3', code: 'host_not_owned' },
          { workspace: WORKTREE, tabId: 'tab-1', code: 'tab_not_found' }
        ]
      },
      frameSeq: 0
    })
  })

  it('names the stream position of the frame its write produced, sent before the reply', async () => {
    let session = sessionListing('tab-1')
    const written = new Set<(hostId: ExecutionHostId | null) => void>()
    const order: string[] = []
    const store: PartialRuntimeStore = {
      getRepo: () => undefined,
      getWorkspaceSessionHostIds: () => ['local'],
      getWorkspaceSession: () => session,
      onWorkspaceSessionWritten: (listener: (hostId: ExecutionHostId | null) => void) => {
        written.add(listener)
        return () => written.delete(listener)
      },
      applyLayoutCommand: vi.fn(async (): Promise<LayoutApplyOutcome> => {
        session = { ...session, activeTabId: null, tabsByWorktree: {} }
        written.forEach((listener) => listener('local'))
        return { ok: true, result: { leafId: 'minted' } }
      })
    }
    const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
    const sent: number[] = []
    const { seq } = runtime.subscribeWorkspaceLayouts((event) => {
      order.push('frame')
      sent.push(event.seq!)
    })

    const reply = await runtime.applyLayoutCommand(SPLIT).then((value) => {
      order.push('reply')
      return value
    })

    expect(sent).toEqual([seq + 1])
    expect(reply.frameSeq).toBe(seq + 1)
    expect(order).toEqual(['frame', 'reply'])
  })
})
