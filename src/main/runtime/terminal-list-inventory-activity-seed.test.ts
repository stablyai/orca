import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'

// STA-4326: after an Orca restart, local daemon PTYs are rediscovered only
// through controller inventory. This main never attached, so onPtyData never
// writes lastOutputAt/preview and `terminal list` reported construction
// defaults (null / "") while `terminal read` already fell back to the
// provider snapshot. List must seed from that same authority once, without
// fabricating recency or doing a daemon round trip per row on every list.

const WORKTREE_ID = 'repo-1::/tmp/inventory-activity'
const UUID = (n: number): string => {
  const hex = n.toString(16).padStart(12, '0')
  return `11111111-1111-4111-8111-${hex}`
}

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/inventory-activity',
        displayName: 'inventory-activity',
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

type SnapshotFn = (ptyId: string) => Promise<PtyProviderBufferSnapshot | null>

function providerSnapshot(data: string): PtyProviderBufferSnapshot {
  return {
    data,
    cols: 80,
    rows: 24,
    seq: 42,
    source: 'headless'
  }
}

function makeRuntime(options: {
  panes: { ptyId: string; leafId: string }[]
  serializeProviderBuffer?: SnapshotFn
}): { runtime: OrcaRuntimeService; serializeProviderBuffer: ReturnType<typeof vi.fn> } {
  const serializeProviderBuffer = vi.fn(
    options.serializeProviderBuffer ??
      (async (ptyId: string) => providerSnapshot(`daemon screen for ${ptyId}\r\n`))
  )
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () =>
      options.panes.map((pane) => ({
        id: pane.ptyId,
        cwd: '/tmp/inventory-activity',
        worktreeId: WORKTREE_ID,
        title: 'shell'
      }))
    ),
    serializeProviderBuffer
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: options.panes.map((pane, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: WORKTREE_ID,
      title: '',
      activeLeafId: pane.leafId,
      layout: null
    })),
    leaves: options.panes.map((pane, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: WORKTREE_ID,
      leafId: pane.leafId,
      paneRuntimeId: 1,
      ptyId: pane.ptyId,
      paneTitle: null,
      title: ''
    }))
  })
  return { runtime, serializeProviderBuffer }
}

describe('listTerminals provider activity seed for never-attached daemon PTYs', () => {
  it('reports the provider screen for a PTY this main never attached to', async () => {
    const ptyId = 'pty-never-attached'
    const { runtime, serializeProviderBuffer } = makeRuntime({
      panes: [{ ptyId, leafId: UUID(1) }],
      serializeProviderBuffer: async () =>
        providerSnapshot('Thinking… 12.4k tokens\r\nEditing src/foo.ts\r\n')
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId,
      connected: true,
      preview: expect.stringContaining('Thinking… 12.4k tokens')
    })
    expect(terminals[0]!.preview).toContain('Editing src/foo.ts')
    // Snapshot bytes are historical — recency is only live onPtyData.
    expect(terminals[0]!.lastOutputAt).toBeNull()
    expect(terminals[0]!.activityObservation).toBeUndefined()
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(serializeProviderBuffer).toHaveBeenCalledWith(
      ptyId,
      expect.objectContaining({ scrollbackRows: expect.any(Number) })
    )
    expect(serializeProviderBuffer.mock.calls[0]![1]!.scrollbackRows).toBeLessThan(120)
  })

  it('leaves an attached PTY that already ingested live bytes unchanged', async () => {
    const livePtyId = 'pty-already-attached'
    const { runtime, serializeProviderBuffer } = makeRuntime({
      panes: [{ ptyId: livePtyId, leafId: UUID(2) }]
    })
    runtime.onPtyData(livePtyId, 'live prompt $\r\n', 1_700_000_000_000)

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: livePtyId,
      connected: true,
      lastOutputAt: 1_700_000_000_000,
      preview: 'live prompt $'
    })
    expect(terminals[0]!.activityObservation).toBeUndefined()
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('marks activity unverifiable when the provider snapshot cannot be consulted', async () => {
    const ptyId = 'pty-snapshot-unavailable'
    const { runtime, serializeProviderBuffer } = makeRuntime({
      panes: [{ ptyId, leafId: UUID(3) }],
      serializeProviderBuffer: async () => null
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId,
      connected: true,
      lastOutputAt: null,
      preview: '',
      activityObservation: 'unverifiable'
    })
    // A missing snapshot is not an exit and must not invent recency.
    expect(terminals[0]!.lastOutputAt).toBeNull()
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('seeds each never-attached PTY once and never round-trips an attached row', async () => {
    const attachedPtyId = 'pty-live'
    const unattached = ['pty-a', 'pty-b', 'pty-c', 'pty-d'].map((ptyId, index) => ({
      ptyId,
      leafId: UUID(10 + index)
    }))
    const { runtime, serializeProviderBuffer } = makeRuntime({
      panes: [{ ptyId: attachedPtyId, leafId: UUID(20) }, ...unattached]
    })
    runtime.onPtyData(attachedPtyId, 'already live\r\n', 42)

    const first = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const second = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(first.terminals).toHaveLength(5)
    expect(second.terminals).toHaveLength(5)
    const unattachedFirst = first.terminals.filter((terminal) => terminal.ptyId !== attachedPtyId)
    expect(unattachedFirst.map((terminal) => terminal.preview)).toEqual([
      'daemon screen for pty-a',
      'daemon screen for pty-b',
      'daemon screen for pty-c',
      'daemon screen for pty-d'
    ])
    expect(unattachedFirst.every((terminal) => terminal.lastOutputAt === null)).toBe(true)
    expect(first.terminals.find((terminal) => terminal.ptyId === attachedPtyId)).toMatchObject({
      lastOutputAt: 42,
      preview: 'already live'
    })
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(unattached.length)
    expect(serializeProviderBuffer.mock.calls.map((call) => call[0])).toEqual(
      unattached.map((pane) => pane.ptyId)
    )
  })

  it('does not spend the restore-tail budget a later read still fetches at 120 rows', async () => {
    const ptyId = 'pty-list-must-not-consume-restore-tail'
    const { runtime, serializeProviderBuffer } = makeRuntime({
      panes: [{ ptyId, leafId: UUID(4) }],
      serializeProviderBuffer: async () =>
        providerSnapshot('Thinking… 12.4k tokens\r\nEditing src/foo.ts\r\n')
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]).toMatchObject({
      ptyId,
      preview: expect.stringContaining('Thinking… 12.4k tokens')
    })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(serializeProviderBuffer.mock.calls[0]![1]!.scrollbackRows).toBeLessThan(120)

    serializeProviderBuffer.mockClear()
    await runtime.readTerminal(terminals[0]!.handle)
    expect(serializeProviderBuffer).toHaveBeenCalledWith(ptyId, { scrollbackRows: 120 })
  })
})
