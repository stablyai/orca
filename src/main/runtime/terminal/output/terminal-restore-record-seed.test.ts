import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import '../../../../shared/workspace-layout/stable-pane-id'
import '../../../../shared/layout-owner-switch'
import '../../orca-runtime-tests/bind-first-pane.test-fixture'

// Reattach restore arrives as RPC data, not onPtyData; seed preview/tail/title without inventing recency or side-effect facts.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = `${WORKTREE_ID}@@session-restore`

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

async function makeRuntimeWithLeaf(): Promise<OrcaRuntimeService> {
  // SAFETY: Restore reads only this fixture's workspace, metadata, and settings capabilities.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY_ID, cwd: '/tmp/probe-worktree' }])
    // SAFETY: Restore uses only the explicitly stubbed PTY inventory, write, and lifecycle operations.
  } as never)
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: '',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

describe('seedTerminalRestoreTail', () => {
  it('lets live bytes land on top of the seed and refuses to re-apply history', async () => {
    const runtime = await makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    runtime.onPtyData(PTY_ID, 'live line\r\n', 1234567)

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('restored line')
    expect(terminal.preview).toContain('live line')
    expect(terminal.lastOutputAt).toBe(1234567)

    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['restored line', 'live line'])
  })

  it('does not seed records that already saw live output', async () => {
    const runtime = await makeRuntimeWithLeaf()

    runtime.onPtyData(PTY_ID, 'live first\r\n', 42)
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'stale history\r\n' })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]!.preview).toBe('live first')
    expect(terminals[0]!.lastOutputAt).toBe(42)
  })

  it('caps the parsed suffix of an oversized payload at a line boundary', async () => {
    const runtime = await makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: `${'x'.repeat(300 * 1024)}\r\npartial-first-line\r\nfinal restored line\r\n`
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('final restored line')
    // The truncated head (which can start mid-escape) is dropped whole.
    expect(terminal.preview).not.toContain('x')
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.truncated).toBe(true)
    expect(read.tail).toEqual(['partial-first-line', 'final restored line'])
  })
})
