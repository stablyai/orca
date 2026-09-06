import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../shared/pty-liveness-verdict'

// The aggregate inventory only enumerates registered providers, so a dropped
// relay clears `connected` for every one of its PTYs at once. Only the
// provider's own answer separates an observed exit from lost contact.

const WORKTREE_ID = 'repo-1::/tmp/inventory-verdict'
const REMOTE_PTY_ID = 'ssh:conn-1@@relay-9'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function makeStore() {
  const session = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/inventory-verdict',
        displayName: 'inventory-verdict',
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

function makeRuntimeMissingFromInventory(
  hasPty: () => boolean | null,
  listProcesses: () => Promise<{ id: string; worktreeId: string }[]> = vi.fn(async () => [])
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    hasPty,
    listProcesses,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  runtime.registerPty(REMOTE_PTY_ID, WORKTREE_ID, 'conn-1')
  return runtime
}

describe('inventory sweep liveness verdicts', () => {
  it('records an abnormal SSH exit as unverifiable at the runtime boundary', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)

    runtime.onPtyExit(REMOTE_PTY_ID, -1)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: SSH_EXIT_UNCONFIRMED_REASON
    })
  })

  it('preserves a more specific lost-contact reason across an abnormal SSH exit', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')

    runtime.onPtyExit(REMOTE_PTY_ID, -1)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'inventory transport failed'
    })
  })

  it('accepts a current owning-host exit even when its numeric code is negative', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')

    runtime.onPtyExit(REMOTE_PTY_ID, -1, undefined, { hostExitConfirmed: true })

    // A host-delivered exit frame is the one signal that observes the process, so it both clears
    // the lost-contact doubt and is retained as the certificate itself.
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({ status: 'exited' })
  })

  it('records lost contact when no provider can answer for the PTY', async () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)

    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'no registered provider can observe its host'
    })
  })

  it('records no doubt when the owning provider reports the PTY absent', async () => {
    const runtime = makeRuntimeMissingFromInventory(() => false)

    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    // An observed absence is the death certificate callers already act on.
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('records no death certificate when a listing of the owning host omits the PTY', async () => {
    // The host answered and named a sibling on the same relay, so this is the strongest absence the
    // inventory can report — and it is still not a certificate. `pty.listProcesses` returns the
    // relay's CURRENT session map, so a relay that restarted omits every id the previous one minted
    // (ids are `pty2:<ptyIdMintEpoch>:<n>` with a fresh epoch per relay start) whether or not those
    // shells ever died. Recording `exited` here would only relocate the fabrication that
    // handlePtyReattachFailure was corrected for (docs/reference/ssh-execution-boundary.md).
    const runtime = makeRuntimeMissingFromInventory(
      () => false,
      vi.fn(async () => [{ id: 'ssh:conn-1@@relay-sibling', worktreeId: WORKTREE_ID }])
    )

    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('clears lost-contact doubt when reconnect inventory observes the PTY live', async () => {
    let reconnected = false
    const runtime = makeRuntimeMissingFromInventory(
      () => null,
      vi.fn(async () => (reconnected ? [{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }] : []))
    )

    await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)?.status).toBe('unverifiable')

    reconnected = true
    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('does not let a pre-drop inventory clear a newer lost-contact verdict', async () => {
    const inventory = deferred<{ id: string; worktreeId: string }[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const runtime = makeRuntimeMissingFromInventory(() => null, listProcesses)

    const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'relay disconnected during stop')
    inventory.resolve([{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }])
    await listing

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'relay disconnected during stop'
    })
  })

  it('does not let a partial inventory overwrite a concurrent provider failure', async () => {
    const inventory = deferred<{ id: string; worktreeId: string }[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const runtime = makeRuntimeMissingFromInventory(() => false, listProcesses)

    const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')
    inventory.resolve([])
    await listing

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'inventory transport failed'
    })
  })

  it('clears stale doubt when a new PTY lifecycle is positively registered', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'old incarnation lost contact')

    runtime.onPtySpawned(REMOTE_PTY_ID, 'incarnation-2')
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()

    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'registration raced reconnect')
    runtime.registerPty(REMOTE_PTY_ID, WORKTREE_ID, 'conn-1', {
      tabId: 'tab-new',
      leafId: '00000000-0000-4000-8000-000000000001',
      incarnationId: 'incarnation-2'
    })
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('retains unresolved verdicts for every still-addressable PTY', () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    for (let index = 0; index < 257; index += 1) {
      const ptyId = `ssh:conn-1@@relay-${index}`
      runtime.registerPty(ptyId, WORKTREE_ID, 'conn-1')
      runtime.markPtyLivenessUnverifiable(ptyId, 'provider disconnected')
    }

    expect(runtime.getPtyLivenessVerdict('ssh:conn-1@@relay-0')).toEqual({
      status: 'unverifiable',
      reason: 'provider disconnected'
    })
  })
})
