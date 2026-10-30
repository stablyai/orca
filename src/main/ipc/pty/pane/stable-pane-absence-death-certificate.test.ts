// Only the owning registry's typed absence can prove exit; an untyped not-found message may instead mean the route was lost.
import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from '../../../runtime/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { adoptStablePane } from './adopt-stable'
import * as providers from '../provider/registry'

const CONNECTION = 'conn-1'
const WORKTREE = 'repo-1::/tmp/pane-absence'
const TAB = 'tab-1'
const LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const SIBLING_LEAF = '2c4d3e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const PTY_ID = 'ssh:conn-1@@pty2:epoch-a:1'

function paneStore(): { store: Store; read: () => WorkspaceSessionState } {
  let session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [{ id: TAB, type: 'terminal', worktreeId: WORKTREE, ptyId: PTY_ID }]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: {
          type: 'split',
          direction: 'row',
          first: { type: 'leaf', leafId: LEAF },
          second: { type: 'leaf', leafId: SIBLING_LEAF }
        },
        activeLeafId: LEAF,
        ptyIdsByLeafId: { [LEAF]: PTY_ID, [SIBLING_LEAF]: 'ssh:conn-1@@pty2:epoch-a:2' }
      }
    }
  } as unknown as WorkspaceSessionState
  return {
    read: () => session,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the persistence methods used by stable-pane retirement and exit bookkeeping.
    store: withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushOrThrow: () => {},
      getRepos: () => [
        {
          id: 'repo-1',
          path: '/tmp/pane-absence',
          displayName: 'pane-absence',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => {},
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => []
    }) as unknown as Store
  }
}

function runtimeOwning(store: Store): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    hasPty: () => null,
    listProcesses: async () => [],
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  runtime.registerPty(PTY_ID, WORKTREE, CONNECTION)
  return runtime
}

async function adoptAfterAttachRefusal(error: unknown): Promise<{
  runtime: OrcaRuntimeService
  store: Store
  read: () => WorkspaceSessionState
  spawn: ReturnType<typeof vi.fn>
}> {
  const { store, read } = paneStore()
  const runtime = runtimeOwning(store)
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty2:epoch-b:1', isReattach: false })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal exits attachment before any provider method other than spawn is used.
  vi.spyOn(providers, 'getProvider').mockReturnValue({ spawn } as unknown as IPtyProvider)
  await adoptStablePane(runtime, store, {
    cols: 80,
    rows: 24,
    tabId: TAB,
    leafId: LEAF,
    worktreeId: WORKTREE,
    connectionId: CONNECTION,
    spawnFresh: () => spawn({ cols: 80, rows: 24 })
  })
  return { runtime, store, read, spawn }
}

describe('a stable pane whose reattach was refused', () => {
  it('certifies an absence reported by the process registry that owns the PTY', async () => {
    // Typed SessionNotFound comes from the owning registry; lost endpoints raise TerminalHostGoneError.
    const { runtime } = await adoptAfterAttachRefusal(new SessionNotFoundError(PTY_ID))

    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'exited' })
  })

  it('refuses to abandon the binding on an untyped "not found" string', async () => {
    const { store, read } = paneStore()
    const before = JSON.stringify(read())
    const runtime = runtimeOwning(store)
    const spawn = vi.fn().mockRejectedValue(new Error(`PTY "pty2:epoch-a:1" not found`))

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rejected attachment calls only spawn and never admits this provider.
    vi.spyOn(providers, 'getProvider').mockReturnValue({ spawn } as unknown as IPtyProvider)
    await expect(
      adoptStablePane(runtime, store, {
        cols: 80,
        rows: 24,
        tabId: TAB,
        leafId: LEAF,
        worktreeId: WORKTREE,
        connectionId: CONNECTION
      })
    ).rejects.toThrow('not found')

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toBeNull()
    expect(JSON.stringify(read())).toBe(before)
  })
})
