import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { NO_OBSERVING_PROVIDER_REASON } from '../../shared/pty-liveness-verdict'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// run6-review-pr-11959 repro: leaf.connected mirrors the graph (`ptyId !== null`),
// so a restored leaf whose PTY no provider owns must be demoted from the
// controller inventory or the CLI reports it connected/writable forever.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const STOP_UNVERIFIED_REASON = 'a follow-up stop was issued but its outcome could not be verified'

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
  hasPty?: (ptyId: string) => boolean | null
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    ...(options.hasPty ? { hasPty: options.hasPty } : {}),
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

  // Why: a just-spawned PTY can register after the inventory snapshot; the
  // provider's sync hasPty must rescue it or federation reads one
  // connected:false as exited.
  it('keeps a leaf connected when the provider synchronously knows a ptyId the snapshot missed', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-just-spawned',
      controllerSessions: [],
      hasPty: (ptyId) => ptyId === 'pty-just-spawned'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-just-spawned',
      connected: true,
      writable: true
    })
  })

  // Coercion site 4 of the failure-becomes-fact class: `hasPty` answering `null`
  // means "the query could not be answered" — the controller adapter returns it
  // for a failed provider lookup or a probe-less provider. That is doubt, never
  // a confirmation of the inventory's absence, so it must not demote the pane.
  it('keeps a leaf connected when the per-id presence query cannot answer (null)', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-unqueryable',
      controllerSessions: [],
      hasPty: () => null
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-unqueryable',
      connected: true,
      writable: true
    })
    // The unanswerable query is recorded as its own answer, so worker
    // observation reports `unverifiable` instead of inventing a verdict.
    expect(runtime.getPtyLivenessVerdict('pty-unqueryable')).toEqual({
      status: 'unverifiable',
      reason: NO_OBSERVING_PROVIDER_REASON
    })
  })

  it('still demotes on an observed-false answer, with no doubt recorded', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-proven-absent',
      controllerSessions: [],
      hasPty: () => false
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-proven-absent',
      connected: false,
      writable: false
    })
    expect(runtime.getPtyLivenessVerdict('pty-proven-absent')).toBeNull()
  })

  // A confirmed absence is positive evidence of the exit, so lost-contact doubt
  // recorded by an earlier unanswerable probe is stale. Publishing
  // `connected:false` while still reporting `unverifiable` would under-report a
  // pane we hold proof about.
  it('clears recorded doubt when the presence query later proves the pane absent', async () => {
    let answer: boolean | null = null
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-doubted-then-absent',
      controllerSessions: [],
      hasPty: () => answer
    })

    await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict('pty-doubted-then-absent')?.status).toBe('unverifiable')

    answer = false
    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]).toMatchObject({ connected: false, writable: false })
    expect(runtime.getPtyLivenessVerdict('pty-doubted-then-absent')).toBeNull()
  })

  it('clears recorded doubt when the presence query later proves the pane live', async () => {
    let answer: boolean | null = null
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-recovering',
      controllerSessions: [],
      hasPty: () => answer
    })

    await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict('pty-recovering')?.status).toBe('unverifiable')

    answer = true
    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]).toMatchObject({ connected: true, writable: true })
    expect(runtime.getPtyLivenessVerdict('pty-recovering')).toBeNull()
  })

  // A stop nobody confirmed records doubt while the exit marks the leaf
  // disconnected. Clearing that doubt on a live rescue answer would publish
  // `connected:false` with no verdict on record, and worker observation reads
  // exactly that pair as a confirmed exit.
  it('keeps recorded doubt for a disconnected leaf the presence query answers live', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-unstopped',
      controllerSessions: [],
      hasPty: () => true
    })
    runtime.markPtyLivenessUnverifiable('pty-unstopped', STOP_UNVERIFIED_REASON)
    // A synthetic -1 from an unverified stop is not a death certificate.
    runtime.onPtyExit('pty-unstopped', -1)

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals[0]).toMatchObject({ ptyId: 'pty-unstopped', connected: false })
    expect(runtime.getPtyLivenessVerdict('pty-unstopped')).toEqual({
      status: 'unverifiable',
      reason: STOP_UNVERIFIED_REASON
    })
  })

  it('never consults the per-id probe for panes the inventory already lists', async () => {
    const hasPty = vi.fn(() => null)
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-live-listed',
      controllerSessions: [{ id: 'pty-live-listed', cwd: '/tmp/probe-worktree' }],
      hasPty
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals[0]).toMatchObject({ connected: true, writable: true })
    expect(hasPty).not.toHaveBeenCalled()
    expect(runtime.getPtyLivenessVerdict('pty-live-listed')).toBeNull()
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
