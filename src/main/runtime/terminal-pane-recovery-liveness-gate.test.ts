import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  createRuntimeWithSshLease,
  deferred,
  store
} from './orca-runtime-test-fixtures.spec'
import { makePaneKey } from './orca-runtime-test-mocks.spec'
import { OrcaRuntimeService } from './orca-runtime'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalResolvePane
} from '../../shared/runtime-terminal-contracts'

// What `terminal.recoverPane` may and may not treat as authority to spawn a replacement shell over
// a remote pane. Lives in a `.test.ts` rather than beside the other recoverPane cases in
// orca-runtime-tests/*.spec.ts because config/vitest.config.ts — the config CI runs — includes only
// `*.test.ts`, so a ratchet placed there would never execute.

describe('terminal.recoverPane liveness gate', () => {
  it('recreates a shell for an SSH pane the relay disowned, the only evidence this gate ever gets', async () => {
    // The whole production route into recoverPane, end to end. A reachable relay answered for this
    // exact id and did not name it — via pty.attach in handlePtyReattachFailure, or the identical
    // answer in the inventory listing below — and that answer is a union: pty.attach throws
    // not-found for an unknown id with no liveness check, and pty.listProcesses returns only
    // the CURRENT session map, which after a relay restart omits every previously minted id. So no
    // `exited` certificate exists to demand here, and no writer of one co-occurs with a
    // reattachable `expired` lease: a host-delivered exit frame tombstones the lease `terminated`
    // instead. Requiring `exited` therefore closes this gate permanently
    // (docs/reference/ssh-execution-boundary.md).
    const tabId = 'tab-relay-disowned'
    const ptyId = 'ssh:ssh-target@@pty-10'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      hasPty: (id: string) => id !== ptyId,
      // A sibling on the same relay still reports, so the host itself answered this listing.
      listProcesses: async () => [
        { id: 'ssh:ssh-target@@pty-sibling', worktreeId: TEST_WORKTREE_ID }
      ],
      getForegroundProcess: async () => null
    } as never)
    registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    // The sweep is what disconnects the pane: handlePtyReattachFailure tells only the renderer and
    // the reattach spawn path only expires the lease, so nothing else reaches the runtime record.
    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict(ptyId)).toBeNull()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('refuses to recreate a shell for an expired lease the host proved is still live', async () => {
    // The production writer: reattach SUCCEEDED and then persistPtyBinding refused the surface, so
    // ssh-relay-session records `live` before writing `expired`. `expired` alone would read as
    // "reattach gave up", and spawning here would put a second agent on a transcript the host just
    // proved is still running.
    const tabId = 'tab-proved-live'
    const ptyId = 'ssh:ssh-target@@pty-11'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1)
    runtime.markPtyLivenessLive(ptyId)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses to recreate a shell for an expired lease whose PTY liveness is unverifiable', async () => {
    // The relay delivers an exit frame carrying code -1 for an SSH pane with no host confirmation
    // (`preservesAbnormalSshSurface`) while the lease is already 'expired'. Neither observed the
    // process, and spawning here rebinds the pane away from a shell still running on the host.
    const tabId = 'tab-unverifiable-gate'
    const ptyId = 'ssh:ssh-target@@pty-12'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1)
    expect(runtime.getPtyLivenessVerdict(ptyId)?.status).toBe('unverifiable')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('still recreates a shell for an SSH pane whose host attested the exit', async () => {
    // The negative control on the other side: a host-delivered exit frame is a real certificate, so
    // the pane a paired client asks about must still get a replacement.
    const tabId = 'tab-attested-gate'
    const ptyId = 'ssh:ssh-target@@pty-13'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1, undefined, { hostExitConfirmed: true })
    expect(runtime.getPtyLivenessVerdict(ptyId)?.status).toBe('exited')
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})

class PaneRecoveryRuntime extends OrcaRuntimeService {
  usePendingRecoveries(pending: Map<string, Promise<RuntimeTerminalResolvePane>>): void {
    this.terminalPaneRecoveryByIdentity = pending
  }

  pendingRecoveries(): Map<string, Promise<RuntimeTerminalResolvePane>> {
    return this.terminalPaneRecoveryByIdentity
  }
}

function createRecoveryPane(tabId: string) {
  const ptyId = 'ssh:ssh-target@@pty-20'
  const now = Date.now()
  const runtime = new PaneRecoveryRuntime({
    ...store,
    getSshRemotePtyLeases: () => [
      {
        targetId: 'ssh-target',
        ptyId: 'pty-20',
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        state: 'expired',
        createdAt: now,
        updatedAt: now
      }
    ]
  })
  const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
  registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
    tabId,
    leafId: HEADLESS_LEAF_ID
  })
  const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
  return { runtime, paneKey, ptyId, handle, recoveryKey: `${TEST_WORKTREE_ID}\0${paneKey}` }
}

function replacementTerminal(tabId: string): RuntimeTerminalCreate {
  return {
    handle: 'term-replacement',
    tabId,
    paneKey: makePaneKey(tabId, HEADLESS_LEAF_ID),
    ptyId: 'pty-replacement',
    worktreeId: TEST_WORKTREE_ID,
    title: null,
    surface: 'background'
  }
}

describe('terminal pane recovery uses the current Root state', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the replacement pending map before connected-pane and lease checks', async () => {
    const tabId = 'tab-current-recovery-map'
    const { runtime, paneKey, handle, recoveryKey } = createRecoveryPane(tabId)
    const original = runtime.pendingRecoveries()
    original.set(
      recoveryKey,
      Promise.resolve({
        handle: 'term-old-map',
        tabId,
        leafId: HEADLESS_LEAF_ID,
        ptyId: null
      })
    )
    const pending = Promise.resolve({
      handle: 'term-current-map',
      tabId,
      leafId: HEADLESS_LEAF_ID,
      ptyId: null
    })
    const current = new Map([[recoveryKey, pending]])
    runtime.usePendingRecoveries(current)
    const create = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-current-map' })
    expect(runtime.pendingRecoveries()).toBe(current)
    expect(current.get(recoveryKey)).toBe(pending)
    expect(original.has(recoveryKey)).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('shares a rejected recovery and removes it before a later retry', async () => {
    const tabId = 'tab-rejected-recovery'
    const { runtime, paneKey, ptyId, handle, recoveryKey } = createRecoveryPane(tabId)
    runtime.onPtyExit(ptyId, -1, undefined, { hostExitConfirmed: true })
    const creation = deferred<RuntimeTerminalCreate>()
    const create = vi
      .spyOn(runtime, 'createTerminal')
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce(replacementTerminal(tabId))
    const first = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    const second = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    const outcomes = Promise.allSettled([first, second])
    expect(create).toHaveBeenCalledOnce()
    expect(runtime.pendingRecoveries().has(recoveryKey)).toBe(true)
    const failure = new Error('relay recovery refused')
    creation.reject(failure)

    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(runtime.pendingRecoveries().has(recoveryKey)).toBe(false)
    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer pending entry when an earlier recovery settles', async () => {
    const tabId = 'tab-newer-recovery'
    const { runtime, paneKey, ptyId, handle, recoveryKey } = createRecoveryPane(tabId)
    runtime.onPtyExit(ptyId, -1, undefined, { hostExitConfirmed: true })
    const creation = deferred<RuntimeTerminalCreate>()
    const create = vi.spyOn(runtime, 'createTerminal').mockImplementation(function (
      this: PaneRecoveryRuntime,
      selector,
      options
    ) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(2)
      expect(selector).toBe(`id:${TEST_WORKTREE_ID}`)
      expect(options).toEqual({ tabId, leafId: HEADLESS_LEAF_ID, focus: false })
      return creation.promise
    })
    const first = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    const newer = Promise.resolve({
      handle: 'term-newer',
      tabId,
      leafId: HEADLESS_LEAF_ID,
      ptyId: null
    })
    const current = new Map([[recoveryKey, newer]])
    runtime.usePendingRecoveries(current)
    creation.resolve(replacementTerminal(tabId))

    await expect(first).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(create).toHaveBeenCalledOnce()
    expect(runtime.pendingRecoveries()).toBe(current)
    expect(current.get(recoveryKey)).toBe(newer)
  })
})
