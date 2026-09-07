import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, makePaneKey } from '../orca-runtime-test-mocks.spec'
import type {
  RuntimeClientEvent,
  RuntimeSyncWindowGraph,
  RuntimeTerminalCreate
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  createRuntimeWithSshLease,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('lists live terminals and issues stable handles for synced leaves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'epoch-terminal-handle',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello from terminal\n', 123)

    const terminals = await runtime.listTerminals('branch:feature/foo')
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: 'repo-1::/tmp/worktree-a',
      branch: 'feature/foo',
      ptyId: 'pty-1',
      title: 'Claude',
      preview: 'hello from terminal'
    })

    const shown = await runtime.showTerminal(terminals.terminals[0].handle)
    expect(shown.handle).toBe(terminals.terminals[0].handle)
    expect(shown.ptyId).toBe('pty-1')
    const mobileTabs = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileHandle = mobileTabs.tabs.find((tab) => tab.type === 'terminal')?.terminal
    if (!mobileHandle) {
      throw new Error('expected mobile terminal handle')
    }

    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await runtime.sleepTerminalsForWorktree('branch:feature/foo')
    expect(
      events.find(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'started'
      )
    ).toMatchObject({
      terminalHandles: [terminals.terminals[0].handle, mobileHandle].sort()
    })
  })

  it('routes a launch-draft resolution to the handle-owning local and remote renderers', async () => {
    const runtime = new OrcaRuntimeService(store)
    const nativeChatLaunchDraftResolved = vi.fn()
    const events: RuntimeClientEvent[] = []
    runtime.setNotifier({ nativeChatLaunchDraftResolved } as never)
    runtime.onClientEvent((event) => events.push(event))
    runtime.attachWindow(1)
    const graph: RuntimeSyncWindowGraph = {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'launch-draft-epoch',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude',
              launchDraft: 'seed',
              launchDraftCreatedAt: 7,
              isActive: true
            }
          ]
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)
    const listed = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileTab = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!mobileTab?.terminal) {
      throw new Error('expected mobile terminal handle')
    }
    expect(mobileTab).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 7 })

    runtime.notifyNativeChatLaunchDraftResolved(mobileTab.terminal, {
      text: 'seed',
      createdAt: 7
    })

    expect(nativeChatLaunchDraftResolved).toHaveBeenCalledWith('tab-1', {
      text: 'seed',
      createdAt: 7
    })
    expect(events).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    expect(runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot()).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    const retired = (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
      (tab) => tab.type === 'terminal'
    )
    expect(retired).not.toHaveProperty('launchDraft')
    expect(retired).not.toHaveProperty('launchDraftCreatedAt')

    runtime.markRendererReloading(1)
    const replay = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 2
      }))
    })
    expect(replay.nativeChatLaunchDraftResolutions).toEqual([
      { tabId: 'tab-1', text: 'seed', createdAt: 7 }
    ])
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).not.toHaveProperty('launchDraft')

    const reconciled = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 3,
        tabs: snapshot.tabs.map((tab) => {
          if (tab.type !== 'terminal') {
            return tab
          }
          return { ...tab, launchDraftCreatedAt: 8 }
        })
      }))
    })
    expect(reconciled.nativeChatLaunchDraftResolutions).toBeUndefined()
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 8 })
  })

  it('surfaces stale terminal handles for stranded panes and recovers after same-pane wake', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-before-sleep'
        }
      ]
    })

    const beforeSleep = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const staleHandle = beforeSleep.terminals[0]?.handle ?? ''
    expect(staleHandle).toBeTruthy()

    // Why: `terminal.show` is read-only; only a later renderer wake/rebind graph publish can repair this pane's CLI handle surface.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })

    await expect(runtime.showTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-after-wake'
        }
      ]
    })
    runtime.onPtyData('pty-after-wake', 'resumed in place\n', 123)

    const resolved = runtime.resolveTerminalPane(paneKey)
    expect(resolved).toMatchObject({
      tabId,
      leafId,
      ptyId: 'pty-after-wake'
    })
    await expect(runtime.showTerminal(resolved.handle)).resolves.toMatchObject({
      handle: resolved.handle,
      tabId,
      leafId,
      ptyId: 'pty-after-wake',
      preview: 'resumed in place'
    })
  })

  it('rejects pane resolution when leaf and PTY ownership disagree', () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-mismatched-owner'
        }
      ]
    })
    runtime.registerPty('pty-mismatched-owner', `${TEST_REPO_ID}::/tmp/other-worktree`)

    expect(() => runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID)).toThrow(
      'terminal_not_found'
    )
  })

  it('recovers a disconnected pane through one HUB-owned replacement', async () => {
    const tabId = 'tab-recover'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
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
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({
      handle: 'term-replacement',
      tabId,
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID
    })
    // persistHostSessionBinding is no longer a per-call opt-in: createTerminal
    // is host-initiated by construction and always persists its binding.
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('rejects missing host panes without authoritative expired binding evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-missing'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-created',
      tabId,
      paneKey,
      ptyId: 'pty-created',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID)).rejects.toThrow(
      'terminal_not_found'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('rejects recovery for live panes and mismatched worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-live'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-live', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const liveHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, liveHandle)
    ).rejects.toThrow('terminal_not_recoverable')
    await expect(
      runtime.recoverTerminalPane(paneKey, `${TEST_REPO_ID}::/other`, liveHandle)
    ).rejects.toThrow('terminal_not_found')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('returns an already-connected replacement instead of spawning another pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-cas'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-old', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const oldHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-old', 0)
    runtime.registerPty('pty-new', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const recovered = await runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)

    expect(recovered.handle).not.toBe(oldHandle)
    expect(recovered.ptyId).toBe('pty-new')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent pane recovery across stale viewer handles', async () => {
    const tabId = 'tab-concurrent'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    let finishCreate!: (result: RuntimeTerminalCreate) => void
    const pendingCreate = new Promise<RuntimeTerminalCreate>((resolve) => {
      finishCreate = resolve
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockReturnValue(pendingCreate)

    const first = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    const second = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, 'term-other-viewer')
    finishCreate({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(first).resolves.toEqual(expect.objectContaining({ handle: 'term-replacement' }))
    await expect(second).rejects.toThrow('terminal_not_found')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('clears a failed pane recovery so a later reconnect can retry', async () => {
    const tabId = 'tab-retry'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('relay_reconnecting'))
      .mockResolvedValueOnce({
        handle: 'term-retry',
        tabId,
        paneKey,
        ptyId: 'pty-retry',
        worktreeId: TEST_WORKTREE_ID,
        title: null,
        surface: 'background'
      })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).rejects.toThrow('relay_reconnecting')
    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({ handle: 'term-retry' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('does not recover a pane whose authoritative SSH lease was terminated', async () => {
    // An SSH pane, so this exercises the same id-form path recovery now travels: `terminated` is
    // also the operator-close state (ssh:terminateSessions), so it must never resurrect a pane.
    const tabId = 'tab-terminated'
    const appPtyId = 'ssh:ssh-target@@pty-terminated'
    const runtime = createRuntimeWithSshLease(appPtyId, tabId, 'terminated')
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('matches an SSH pane against its own lease across the relay/app id forms', async () => {
    // Leases are stored in RELAY form: upsertSshRemotePtyLease and markSshRemotePtyLease both run
    // ids through toStoredPtyId -> toRelaySshPtyId ("pty-3"). The runtime holds the APP form
    // ("ssh:ssh-target@@pty-3"). getRecentExpiredSshLease compared the two raw, so this branch was
    // unreachable for exactly the panes it names; it now normalizes before comparing.
    const tabId = 'tab-id-form'
    const appPtyId = 'ssh:ssh-target@@pty-3'
    const runtime = createRuntimeWithSshLease(appPtyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, 0)
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
    // createTerminal is the re-adopt entry point, not a bare spawn: it calls adoptStablePane first,
    // so a surviving orphan is reattached and only a host-confirmed absence falls through to a
    // fresh shell.
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('does not recover a pane whose expired lease was superseded by a newer one', async () => {
    // #17966 split supersession out of plain `expired`: `supersededBy` names the lease that won
    // this pane, so this id no longer routes to the shell the lease describes.
    const tabId = 'tab-superseded'
    const appPtyId = 'ssh:ssh-target@@pty-5'
    const runtime = createRuntimeWithSshLease(appPtyId, tabId, 'expired', {
      supersededBy: 'pty-6'
    })
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('does not recover a pane whose expired lease had its relay id recycled', async () => {
    const tabId = 'tab-recycled'
    const appPtyId = 'ssh:ssh-target@@pty-7'
    const runtime = createRuntimeWithSshLease(appPtyId, tabId, 'expired', {
      relayIdRecycled: true
    })
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('does not recreate a shell for an expired lease whose PTY liveness is unverifiable', async () => {
    // The production sequence this guards: the relay delivers an exit frame carrying code -1 for an
    // SSH pane with no host confirmation (`preservesAbnormalSshSurface`), while the pane's lease is
    // already 'expired'. Neither observed the process — every writer of 'expired' documents it as
    // "the client lost its route", and code -1 with no host confirmation is recorded
    // 'unverifiable'. Spawning a replacement there rebinds the pane away from a remote shell still
    // running on the host and duplicates its agent. This is the `unverifiable` arm only; the
    // relay's own absence branch (`handlePtyReattachFailure`) reaches the runtime with no verdict
    // at all, and is covered by the relay-disowned case in terminal-handles-part-02.spec.ts.
    const tabId = 'tab-unverifiable'
    const ptyId = 'ssh:ssh-target@@pty-3'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1)
    expect(runtime.getPtyLivenessVerdict(ptyId)?.status).toBe('unverifiable')
    // Resolve rather than call through, so a regression shows up as "spawned a second shell"
    // rather than as whatever createTerminal happens to throw in the fixture.
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('still recreates a shell for an SSH pane whose host confirmed the exit', async () => {
    // The other direction: a host-confirmed exit leaves no unverifiable verdict, so the pane a
    // paired client asks about must still get a replacement shell.
    const tabId = 'tab-ssh-exited'
    const ptyId = 'ssh:ssh-target@@pty-4'
    const runtime = createRuntimeWithSshLease(ptyId, tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(ptyId, -1, undefined, { hostExitConfirmed: true })
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

  it('drops a stale leaf when a woken agent PTY is re-keyed to a new leaf on renderer reload', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Why: the agent's pre-allocated ORCA_TERMINAL_HANDLE gives its PTY a handleByPtyId entry — the condition the reload preservation loop keys on.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)

    // Simulate agent sleep + mobile wake: the renderer cold-restores the pane under a NEW leafId while the SAME agent PTY stays live.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    // Before the fix two leaves shared one PTY, so both adopted the same ptyId-keyed handle and paired clients crashed on a duplicate React key.
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
    // The shared handle must NOT have been invalidated — it belongs to leaf-new now.
    await expect(runtime.showTerminal(after.terminals[0].handle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })
  })

  it('still preserves a CLI agent leaf when the reloaded renderer has not rebound its PTY', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    expect((await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals).toHaveLength(1)

    // Renderer reloads but hasn't rebound the pane (empty graph); the live CLI agent PTY + exported handle must survive.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
  })
})
