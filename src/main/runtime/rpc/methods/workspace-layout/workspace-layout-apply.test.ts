import '../../../../../shared/protocol-version'
import '../../../../../shared/workspace-layout/published-layout/layout-intents-capability'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

import type { ExecutionHostId } from '../../../../../shared/execution-host'

import type { LayoutApplyOutcome } from '../../../../../shared/workspace-layout/workspace-layout-command-types'

import '../../../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
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
  '../../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard',
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
