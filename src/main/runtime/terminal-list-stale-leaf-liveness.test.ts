import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'

// STA repro (run6-review-pr-11959 incident): a renderer-published leaf whose
// ptyId no PTY provider owns anymore (e.g. a persisted surface restored after a
// restart, or a pane that never completed its initial attach) must not be
// reported connected/writable to external automation. `leaf.connected` mirrors
// `ptyId !== null` from the graph, so without consulting the controller
// inventory the CLI reports connected=true, writable=true with empty
// title/lastOutputAt/preview forever — the exact incident signature.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

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

type ControllerSession = { id: string; cwd: string; title?: string }

function makeRuntimeWithLeaf(options: {
  leafPtyId: string
  controllerSessions: ControllerSession[] | 'unavailable'
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses:
      options.controllerSessions === 'unavailable'
        ? vi.fn(async () => {
            throw new Error('controller unavailable')
          })
        : vi.fn(async () => options.controllerSessions)
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
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
        ptyId: options.leafPtyId,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

describe('listTerminals liveness truth for restored leaves', () => {
  it('reports a leaf disconnected when the controller inventory proves its local ptyId absent', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-stale-from-prior-run',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-stale-from-prior-run',
      connected: false,
      writable: false
    })
  })

  it('keeps a leaf connected when its ptyId is in the controller inventory', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-live-1',
      controllerSessions: [{ id: 'pty-live-1', cwd: '/tmp/probe-worktree' }]
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-live-1',
      connected: true,
      writable: true
    })
  })

  it('never demotes on an unavailable inventory — unknown liveness is not absence', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-stale-from-prior-run',
      controllerSessions: 'unavailable'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-stale-from-prior-run',
      connected: true,
      writable: true
    })
  })

  it('does not demote remote-runtime-scoped leaves the local inventory never covers', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'remote:env-1@@term_abc',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'remote:env-1@@term_abc',
      connected: true,
      writable: true
    })
  })

  it('does not demote SSH-scoped leaves the aggregate inventory may not cover', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'ssh:target-1@@session-9',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'ssh:target-1@@session-9',
      connected: true,
      writable: true
    })
  })
})
