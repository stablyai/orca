// Only the owning registry's typed absence can prove exit; an untyped not-found message may instead mean the route was lost.
import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from '../../../runtime/orca-runtime-tests/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { Store } from '../../../persistence/loading-store/store'
import { TerminalSessionOwnerUnverifiedError } from '../../../daemon/protocol/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
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

describe('a stable pane whose reattach was refused', () => {
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

  // #25286: a paused shell's reattach beside an unresponsive legacy daemon must not
  // dead-end on the unverified banner when main watched the expected incarnation exit.
  it('respawns fresh when the unverified owner was a certified exit of the expected incarnation', async () => {
    const { store, read } = paneStore()
    const paneKey = `${TAB}:${LEAF}`
    store.setWorkspaceSession({
      ...read(),
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'incarnation-1' }
    })
    const runtime = new OrcaRuntimeService()
    runtime.onPtyExit(PTY_ID, 0, 'incarnation-1', { providerExitObserved: true })
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toMatchObject({
      status: 'exited',
      incarnationId: 'incarnation-1'
    })
    const spawn = vi
      .fn()
      .mockRejectedValueOnce(new TerminalSessionOwnerUnverifiedError(PTY_ID))
      .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty2:epoch-b:1', isReattach: false })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refused attachment falls through to the fresh spawn, which never admits this provider.
    vi.spyOn(providers, 'getProvider').mockReturnValue({ spawn } as unknown as IPtyProvider)
    const result = await adoptStablePane(runtime, store, {
      cols: 80,
      rows: 24,
      tabId: TAB,
      leafId: LEAF,
      worktreeId: WORKTREE,
      connectionId: CONNECTION,
      spawnFresh: () => spawn({ cols: 80, rows: 24 })
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(result).toBeNull()
    expect(read().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
  })

  it('keeps the unverified banner when the certified exit was another incarnation of the id', async () => {
    const { store, read } = paneStore()
    store.setWorkspaceSession({
      ...read(),
      terminalPtyIncarnationsByPaneKey: { [`${TAB}:${LEAF}`]: 'incarnation-1' }
    })
    const before = JSON.stringify(read())
    const runtime = new OrcaRuntimeService()
    runtime.onPtyExit(PTY_ID, 0, 'incarnation-2', { providerExitObserved: true })
    const spawn = vi.fn().mockRejectedValue(new TerminalSessionOwnerUnverifiedError(PTY_ID))

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the banner refusal never admits this provider.
    vi.spyOn(providers, 'getProvider').mockReturnValue({ spawn } as unknown as IPtyProvider)
    await expect(
      adoptStablePane(runtime, store, {
        cols: 80,
        rows: 24,
        tabId: TAB,
        leafId: LEAF,
        worktreeId: WORKTREE,
        connectionId: CONNECTION,
        spawnFresh: () => spawn({ cols: 80, rows: 24 })
      })
    ).rejects.toThrow('terminal_pane_owner_unverified')

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(read())).toBe(before)
  })
})
