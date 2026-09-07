// `attachStablePaneOwner` is the last reader that synthesised a runtime exit from a reattach
// refusal, and it published code 0 — which `orca-runtime-on-pty-exit` records as a death
// certificate. The refusal it acts on is a union: `pty.attach` answers absent both for a pid the
// relay probed and found gone, and for an id its session map never had, which is every id minted
// before a relay restart. Certifying the union orphans a live remote shell and cold-starts a second
// agent onto its transcript (docs/reference/ssh-execution-boundary.md).
//
// The sibling handlePtyReattachFailure has always refused to certify from that union. These pin the
// same rule here, and pin that the marked half — the one refusal the relay backed with a pid probe
// — still earns the certificate, so a genuinely dead PTY is not left `unverifiable` forever.
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../../../shared/pty-liveness-verdict'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence'
import {
  SSH_SESSION_EXPIRED_ERROR,
  SshPtyAbsentFromRelayError,
  SshPtyProvenExitedOnRelayError
} from '../../../providers/ssh-pty-errors'
import type { IPtyProvider } from '../../../providers/types'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolvePersistedStablePaneOwner, spawnForStablePane } from './stable-owner'

const CONNECTION = 'conn-1'
const WORKTREE = 'repo-1::/tmp/pane-absence'
const TAB = 'tab-1'
const LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const SIBLING_LEAF = '2c4d3e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
// Ids carry the relay's per-start mint epoch, so this one names a PTY the CURRENT relay never minted.
const PTY_ID = 'ssh:conn-1@@pty2:epoch-a:1'
const OWNER = { tabId: TAB, leafId: LEAF, ptyId: PTY_ID, hasPersistedBinding: true as const }

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
    store: {
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
    } as unknown as Store
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
  await spawnForStablePane({
    runtime,
    store,
    provider: { spawn } as unknown as IPtyProvider,
    spawnOptions: { cols: 80, rows: 24 },
    owner: OWNER,
    worktreeId: WORKTREE,
    connectionId: CONNECTION,
    resolveOwner: () => null
  })
  return { runtime, store, read, spawn }
}

describe('a stable pane whose reattach was refused', () => {
  it('records no death certificate when the relay merely does not know the id', async () => {
    const { runtime, spawn } = await adoptAfterAttachRefusal(
      new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty2:epoch-a:1`)
    )

    expect(spawn).toHaveBeenCalledTimes(2)
    // The shell may well still be running under the previous daemon's orphaned process tree, so the
    // register must keep saying "we could not observe it" — not "it ended".
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: SSH_EXIT_UNCONFIRMED_REASON
    })
  })

  it('still certifies the death the relay proved with a pid probe', async () => {
    const { runtime, store, spawn } = await adoptAfterAttachRefusal(
      new SshPtyProvenExitedOnRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty2:epoch-a:1`)
    )

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'exited' })
    // If nothing ever retired, a proven-dead pane would reattach to a corpse on every adoption.
    expect(
      resolvePersistedStablePaneOwner(store, makePaneKey(TAB, LEAF), WORKTREE, CONNECTION)
    ).toBeNull()
  })

  it('certifies an absence reported by the process registry that owns the PTY', async () => {
    // The daemon (or the in-process map) answering here is the owner of the process, and an
    // endpoint that had gone raises TerminalHostGoneError above, so this absence is an observation
    // rather than a lost route.
    const { runtime } = await adoptAfterAttachRefusal(new SessionNotFoundError(PTY_ID))

    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'exited' })
  })

  it('refuses to abandon the binding on an untyped "not found" string', async () => {
    // The relay's raw wire wording. The SSH reattach path types it before any pane sees it, so an
    // untyped one reached this gate having lost every distinction the type carries — including
    // whether the answer came from the host that owns the process at all.
    const { store, read } = paneStore()
    const before = JSON.stringify(read())
    const runtime = runtimeOwning(store)
    const spawn = vi.fn().mockRejectedValue(new Error(`PTY "pty2:epoch-a:1" not found`))

    await expect(
      spawnForStablePane({
        runtime,
        store,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        worktreeId: WORKTREE,
        connectionId: CONNECTION,
        resolveOwner: () => null
      })
    ).rejects.toThrow('not found')

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toBeNull()
    expect(JSON.stringify(read())).toBe(before)
  })
})
