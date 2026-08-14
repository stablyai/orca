import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// STA repro (post-restart blind orchestrator incident): after an app relaunch
// the daemon survives and spawn reattaches silently, but the restore payload
// (snapshot/scrollback/replay + lastTitle) arrives as an RPC result, never as
// an onPtyData event. The runtime's terminal records therefore stayed empty:
// `terminal list` showed connected terminals with no title/preview/lastOutputAt
// and `terminal read` returned a zero-line tail for a running session.
// seedTerminalRestoreTail must fill preview/tail/title from the payload —
// WITHOUT fabricating recency (lastOutputAt) or emitting side-effect facts.

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

function makeRuntimeWithLeaf(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY_ID, cwd: '/tmp/probe-worktree' }])
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
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

type RuntimeRecordInternals = {
  ptysById: Map<
    string,
    {
      preview: string
      lastOutputAt: number | null
      waitBlockedAt: number | null
      lastOscTitle: string | null
      tailBuffer: string[]
    }
  >
  ptyTitleTrackersByPtyId: Map<string, { pendingFacts: unknown[] }>
}

describe('seedTerminalRestoreTail', () => {
  it('seeds preview/tail/title from a restore payload without fabricating recency', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: '\x1b]0;osc-title-noise\x07\x1b[32m$ npm test\x1b[0m\r\n\x1b[1mall 42 tests passed\x1b[0m\r\nspinner frame 1\rspinner frame 2\r\n',
      lastTitle: 'restored-agent-title'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals).toHaveLength(1)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('$ npm test')
    expect(terminal.preview).toContain('all 42 tests passed')
    // CR redraws collapse to the surviving frame, exactly like live bytes.
    expect(terminal.preview).toContain('spinner frame 2')
    expect(terminal.preview).not.toContain('spinner frame 1')
    expect(terminal.preview).not.toContain('\x1b')
    expect(terminal.title).toBe('restored-agent-title')
    // Seeded scrollback is historical — recency must come only from live bytes.
    expect(terminal.lastOutputAt).toBeNull()

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['$ npm test', 'all 42 tests passed', 'spinner frame 2'])

    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(PTY_ID)!
    expect(pty.preview).toContain('all 42 tests passed')
    expect(pty.lastOutputAt).toBeNull()
    expect(pty.waitBlockedAt).toBeNull()
    expect(pty.lastOscTitle).toBe('restored-agent-title')
    // Seed semantics: state writes only — no side-effect facts to deliver.
    expect(internals.ptyTitleTrackersByPtyId.get(PTY_ID)?.pendingFacts ?? []).toEqual([])
  })

  it('lets live bytes land on top of the seed and refuses to re-apply history', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    runtime.onPtyData(PTY_ID, 'live line\r\n', 1234567)

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('restored line')
    expect(terminal.preview).toContain('live line')
    expect(terminal.lastOutputAt).toBe(1234567)

    // A remount reattach delivering the same payload again must be a no-op.
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['restored line', 'live line'])
  })

  it('does not seed records that already saw live output', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.onPtyData(PTY_ID, 'live first\r\n', 42)
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'stale history\r\n' })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]!.preview).toBe('live first')
    expect(terminals[0]!.lastOutputAt).toBe(42)
  })

  it('keeps a live-tracked title over the payload title', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.onPtyData(PTY_ID, '\x1b]0;live-title\x07', 42)
    runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: 'stale-persisted-title' })

    const internals = runtime as unknown as RuntimeRecordInternals
    expect(internals.ptysById.get(PTY_ID)!.lastOscTitle).toBe('live-title')
  })

  it('seeds title-only payloads (no restore text)', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: 'title-only-restore' })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]!.title).toBe('title-only-restore')
    expect(terminals[0]!.preview).toBe('')
    expect(terminals[0]!.lastOutputAt).toBeNull()
  })

  it('caps the parsed suffix of an oversized payload at a line boundary', async () => {
    const runtime = makeRuntimeWithLeaf()

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

  it('does not stamp waitBlockedAt from a blocked prompt that exists only in seeded history', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: 'Do you trust this workspace?\r\nPress t to trust\r\n'
    })
    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(PTY_ID)!
    expect(pty.waitBlockedAt).toBeNull()

    // A benign heartbeat must not resurrect the historical prompt as blocked NOW.
    runtime.onPtyData(PTY_ID, 'heartbeat ok\r\n', 1_000_000)
    expect(pty.waitBlockedAt).toBeNull()

    // A prompt arriving in genuinely new output still stamps.
    runtime.onPtyData(PTY_ID, 'Do you trust this workspace?\r\nPress t to trust\r\n', 2_000_000)
    expect(pty.waitBlockedAt).toBe(2_000_000)
  })

  it('seeds the pty record for a daemon-scoped id with no synced leaf', async () => {
    const runtime = makeRuntimeWithLeaf()
    const orphanPtyId = `${WORKTREE_ID}@@session-orphan`

    runtime.seedTerminalRestoreTail(orphanPtyId, { text: 'orphan restored\r\n' })

    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(orphanPtyId)!
    expect(pty.preview).toBe('orphan restored')
    expect(pty.lastOutputAt).toBeNull()
  })
})
