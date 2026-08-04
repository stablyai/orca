import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'

// STA repro (silent-send incident): `orca terminal send` to a leaf whose ptyId
// no provider in this process owns was a silent no-op reported as success —
// the stale graph mirror answers writable=true and provider writes to unknown
// ids are accepted fire-and-forget. The leaf branch must reject ONLY on
// controller-proven absence; unknown liveness never rejects (a restored daemon
// session legitimately accepts writes before its pane remounts).

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const STALE_PTY_ID = 'pty-stale-from-prior-run'

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

async function makeRuntimeWithLeafHandle(options: {
  leafPtyId?: string
  probePtyLiveness?: (ptyId: string) => Promise<boolean | null>
  hasPty?: (ptyId: string) => boolean | null
}): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  write: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    ...(options.hasPty ? { hasPty: options.hasPty } : {}),
    ...(options.probePtyLiveness ? { probePtyLiveness: options.probePtyLiveness } : {})
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Codex',
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
        ptyId: options.leafPtyId ?? STALE_PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle, write }
}

describe('sendTerminal absence gate for leaf-branch writes', () => {
  it('rejects only on controller-proven absence and never dispatches the write', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(probe).toHaveBeenCalledWith(STALE_PTY_ID)
    expect(write).not.toHaveBeenCalled()
  })

  it('gates agent prompt sends behind the same proven-absence check', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminalAgentPrompt(handle, 'do the thing')).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('proceeds when the probe answers unknown (null) — unknown is not absence', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => null
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      handle,
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('treats a throwing probe as unknown and proceeds', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => {
        throw new Error('probe transport down')
      }
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('proceeds when the probe answers live (restored session before its pane remounts)', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => true
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('proceeds unchanged when the controller exposes no probe', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({})

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('never probes when the provider synchronously knows the id (live pty)', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: probe,
      hasPty: (ptyId) => ptyId === STALE_PTY_ID
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(probe).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('reuses a proven-absent verdict across repeated sends instead of re-probing', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminal(handle, { text: 'a' })).rejects.toThrow(
      'terminal_not_writable'
    )
    await expect(runtime.sendTerminal(handle, { text: 'b' })).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('drops the cached absent verdict once the provider re-learns the id', async () => {
    const probe = vi.fn(async () => false)
    const livePtyIds = new Set<string>()
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: probe,
      hasPty: (ptyId) => livePtyIds.has(ptyId)
    })

    await expect(runtime.sendTerminal(handle, { text: 'a' })).rejects.toThrow(
      'terminal_not_writable'
    )
    // Same id recreated by a fresh spawn: provider knowledge must beat the verdict.
    livePtyIds.add(STALE_PTY_ID)

    await expect(runtime.sendTerminal(handle, { text: 'b' })).resolves.toMatchObject({
      accepted: true
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'b')
  })
})

type StoredMessageRow = {
  id: string
  run_id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: string
  priority: string
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: null
}

function makeOrchestrationDbStub(toHandle: () => string) {
  const rows: StoredMessageRow[] = []
  const markAsDelivered = vi.fn((ids: string[]) => {
    for (const row of rows) {
      if (ids.includes(row.id)) {
        row.delivered_at = 'now'
      }
    }
  })
  return {
    rows,
    markAsDelivered,
    insert(subject: string): void {
      rows.push({
        id: `msg_${rows.length + 1}`,
        run_id: 'run_test',
        from_handle: 'term_sender',
        to_handle: toHandle(),
        subject,
        body: '',
        type: 'status',
        priority: 'normal',
        thread_id: null,
        payload: null,
        read: 0,
        sequence: rows.length + 1,
        created_at: 'now',
        delivered_at: null,
        sender_pane_key: null
      })
    },
    db: {
      getUndeliveredUnreadMessages: (handle: string) =>
        rows.filter((row) => row.to_handle === handle && !row.delivered_at),
      getActiveCoordinatorRun: () => null,
      markAsDelivered,
      close: () => {}
    }
  }
}

describe('push-on-idle orchestration delivery absence gate', () => {
  async function makeIdleLeafWithoutPtyRecord(options: {
    probePtyLiveness: (ptyId: string) => Promise<boolean | null>
  }) {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle(options)
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    // Title transitions mark the leaf idle; the provider never knew this id
    // (no controller hasPty), modeling a leaf restored from a prior process.
    runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex done\x07', 101)
    return { runtime, handle, write, stub }
  }

  it('keeps messages queued instead of marking a proven-absent pty delivered', async () => {
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: async () => false
    })
    stub.insert('lost forever?')

    runtime.deliverPendingMessagesForHandle(handle)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).not.toHaveBeenCalled()
    expect(stub.markAsDelivered).not.toHaveBeenCalled()
    expect(stub.rows[0].delivered_at).toBeNull()
  })

  it('still delivers on unknown liveness after the probe resolves', async () => {
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: async () => null
    })
    stub.insert('hello')

    runtime.deliverPendingMessagesForHandle(handle)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, expect.stringContaining('Subject: hello'))
  })
})
