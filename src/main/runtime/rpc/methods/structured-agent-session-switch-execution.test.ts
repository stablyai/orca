import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A,
  PTY_B,
  LEAF_B
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import {
  keptSourceTerminal,
  savedTranscript,
  startSwitchFromKeptTerminal,
  switchFromKeptTerminal
} from './structured-agent-session-switch-execution.test-fixture'
import {
  TerminalNotPlacedError,
  TerminalRevealUnconfirmedError
} from '../../session-tabs/terminal-not-placed-error'
import { refusedMobileSessionTabClose } from '../../mobile-session-tab-close-outcome'
import { AGENT_SESSION_SWITCH_HOST_MS } from '../../../../shared/agent-session-switch-execution'
import { DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import { chatTabId, withSelectedChatTab } from '../../agent-session/agent-session-tab-layout'

let rig: RestTestRig
let releaseReceiverExit: (() => void) | undefined
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  releaseReceiverExit?.()
  releaseReceiverExit = undefined
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

it.each(['single', 'split', 'other-workspace', 'reselected'] as const)(
  'uses ordinary exact physical exit and source placement, retaining siblings: %s',
  async (shape) => {
    const split = shape === 'split'
    const elsewhere = shape === 'other-workspace'
    const sessionId = elsewhere ? 'existing-native-elsewhere' : id
    const destinationWorkspace = elsewhere ? 'repo-1::/other-workspace' : WORKTREE_ID
    if (elsewhere) {
      const acquire = rig.adapter.acquire.getMockImplementation()!
      rig.adapter.acquire.mockImplementation(async (input) => {
        const resumed = Boolean(
          rig.store.getRecord(input.identity.sessionId)?.providerHandleChain.length
        )
        const receipt = await acquire(input)
        if (!receipt.link) {
          throw new Error('missing fixture provider identity')
        }
        return {
          ...receipt,
          link: { ...receipt.link, origin: resumed ? 'resumed' : 'created' }
        }
      })
      const params = createTestParams()
      expect(
        await rig.host.create(
          caller,
          createTestParams(undefined, {
            envelope: { ...params.envelope, sessionId },
            location: { ...params.location, workspaceId: destinationWorkspace }
          })
        )
      ).toMatchObject({ ok: true })
    }
    await savedTranscript(rig, sessionId)
    const { runtime, session, setSession } = setupMainOwnedWorkspace({ split: shape === 'split' })
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing captured source')
    }
    const exit = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const stopped = vi.fn(async (ptyId: string) => {
      expect(ptyId).toBe(PTY_A)
      entered.resolve()
      await exit.promise
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: stopped,
      getForegroundProcess: async () => 'codex'
    })
    expect(
      await runtime.applyLayoutCommand({
        type: 'openAgentSessionTab',
        workspace: WORKTREE_ID,
        sessionId: 'later-tab',
        agent: 'codex',
        tabId: 'agent-session:later-tab'
      })
    ).toMatchObject({ ok: true })
    // The user picked another tab while the switch ran: the chat takes the slot, not the selection.
    if (shape === 'reselected') {
      setSession(withSelectedChatTab('local', session(), WORKTREE_ID, 'later-tab') ?? session())
    }
    if (elsewhere) {
      await runtime.publishStructuredAgentSessionTab({
        workspaceId: destinationWorkspace,
        sessionId,
        agent: 'codex',
        activate: false
      })
    }
    const existingDestination = elsewhere
      ? await vi.waitFor(() => {
          const tabs =
            session().unifiedTabs?.[destinationWorkspace]?.filter(
              (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
            ) ?? []
          expect(tabs).toHaveLength(1)
          const tab = tabs[0]!
          const group = session().tabGroups?.[destinationWorkspace]?.find((row) =>
            row.tabOrder.includes(tab.id)
          )
          expect(group?.tabOrder).toEqual([tab.id])
          return { tabId: tab.id, groupId: group!.id, tabOrder: [...group!.tabOrder] }
        })
      : undefined
    const focusEditorTab = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn(),
      focusEditorTab
    })
    const acquisitions = rig.adapter.acquire.mock.calls.length
    const operation = executeStructuredSessionSwitch(
      {
        sessionId,
        execution: {
          invocationId: 'from-pane',
          source: {
            terminal: source.handle,
            expectedIncarnationId: incarnationId,
            originalPresentation: source.presentation
          }
        }
      },
      { runtime },
      'chat'
    )
    await Promise.race([
      entered.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    exit.resolve()
    expect(await operation).toEqual({ status: 'completed', sessionId })
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions + 1))
    expect(stopped).toHaveBeenCalledOnce()
    const destination = `agent-session:${sessionId}`
    const savedDestination = existingDestination?.tabId ?? destination
    const group = session().tabGroups?.[destinationWorkspace]?.find((row) =>
      existingDestination
        ? row.id === existingDestination.groupId
        : row.tabOrder.includes(destination)
    )
    expect(group?.tabOrder).toEqual(
      existingDestination?.tabOrder ?? [
        ...(split ? [TAB_ID] : []),
        destination,
        ...(elsewhere ? [] : ['agent-session:later-tab'])
      ]
    )
    expect(group?.activeTabId).toBe(
      shape === 'reselected' ? 'agent-session:later-tab' : savedDestination
    )
    if (existingDestination) {
      expect(
        session().unifiedTabs?.[destinationWorkspace]?.find(
          (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
        )?.id
      ).toBe(existingDestination.tabId)
    }
    const published = await runtime.listMobileSessionTabs(`id:${destinationWorkspace}`)
    // Paired clients put the chat where they showed its source: its slot, or beside a split pane.
    expect(published.tabs.find((tab) => tab.id === destination)).toMatchObject(
      elsewhere ? {} : split ? { after: { tabId: TAB_ID } } : { replaces: { tabId: TAB_ID } }
    )
    if (split) {
      // The window's focus is judged against the split pane's tab the chat opened beside.
      expect(focusEditorTab).toHaveBeenCalledWith(expect.any(String), WORKTREE_ID, TAB_ID)
    }
    // What paired clients mirror is the write's decision: a user who picked another tab keeps it.
    expect(published.activeTabId === destination).toBe(shape !== 'reselected')
    if (!split && !elsewhere) {
      // A whole tab is replaced in the one write: its rows are gone from the published snapshot.
      expect(
        published.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === TAB_ID)
      ).toBe(false)
    }
    if (elsewhere) {
      expect(rig.store.getRecord(sessionId)?.location.workspaceId).toBe(destinationWorkspace)
    }
    const layout = session().terminalLayoutsByTabId[TAB_ID]
    if (split) {
      expect(layout?.ptyIdsByLeafId?.[LEAF_B]).toBe(PTY_B)
      expect(layout?.root).toEqual({ type: 'leaf', leafId: LEAF_B })
    } else {
      // Replaced in place, or (in another workspace, where nothing replaces it) exited as any
      // stopped pane does.
      expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(false)
    }
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('keeps the stopped source when destination publication fails before retirement', async () => {
  await savedTranscript(rig)
  const { runtime, session } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const originalSourceTabs = structuredClone(session().tabsByWorktree[WORKTREE_ID])
  const originalSourceLayout = structuredClone(session().terminalLayoutsByTabId[TAB_ID])
  const acquisitions = rig.adapter.acquire.mock.calls.length
  const stop = vi.fn(async () => {
    await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
    return true
  })
  const kill = vi.fn(() => false)
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait: stop,
    getForegroundProcess: async () => null
  })
  const publish = vi
    .spyOn(runtime, 'publishStructuredAgentSessionTab')
    .mockRejectedValue(new Error('fixture publication failure'))
  const result = await executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'publication-failure',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    },
    { runtime },
    'chat'
  )
  expect(result).toMatchObject({
    status: 'refused',
    refusal: { code: 'agent_session_owner_restart_failed' }
  })
  expect(stop).toHaveBeenCalledExactlyOnceWith(
    PTY_A,
    expect.objectContaining({ expectedIncarnationId: incarnationId })
  )
  expect(runtime.getPtyLivenessVerdict(PTY_A)).toMatchObject({ status: 'exited' })
  expect(publish).toHaveBeenCalledOnce()
  // The slot anchor is withdrawn: a later open of the chat is not stamped into the stopped tab.
  const later = runtime.switchSlotAnchors.stamp({
    worktree: WORKTREE_ID,
    publicationEpoch: 'later',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${id}`,
        title: 'Codex',
        sessionId: id,
        agent: 'codex',
        isActive: false
      }
    ]
  })
  expect(later.tabs[0]).not.toHaveProperty('replaces')
  expect(later.tabs[0]).not.toHaveProperty('after')
  expect(session().tabsByWorktree[WORKTREE_ID]).toEqual(originalSourceTabs)
  expect(session().terminalLayoutsByTabId[TAB_ID]).toEqual(originalSourceLayout)
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})

it('does not acquire or retire a terminal whose physical stop is unproven', async () => {
  await savedTranscript(rig)
  const { runtime, session } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const acquisitions = rig.adapter.acquire.mock.calls.length
  const stop = vi.fn(async () => false)
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: stop,
    getForegroundProcess: async () => null
  })
  const result = await executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'unproven',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    },
    { runtime },
    'chat'
  )
  expect(result.status).toBe('refused')
  expect(stop).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(true)
})

it('reports a dispatched terminal with a lost answer as uncertain, preserving its source', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await rig.store.setSessionTabVisibility(id, false)
  await rig.store.setSessionTabVisibility(id, true, 'source-chat')
  vi.spyOn(runtime, 'spawnSwitchTerminal').mockRejectedValue(
    new DaemonRequestTimeoutError('raw daemon text must not become start-failed copy')
  )
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'lost', sourceTabId: 'source-chat' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({
    status: 'uncertain',
    refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
  })
  expect(rig.store.getSessionTabId(id)).toBe('source-chat')
})

it('puts the switched terminal in the chat tab’s slot and closes the chat tab, in one write', async () => {
  const { runtime, session } = setupMainOwnedWorkspace()
  const chatTab = chatTabId(id)
  for (const [sessionId, tabId] of [
    [id, chatTab],
    ['later-tab', 'agent-session:later-tab']
  ] as const) {
    expect(
      await runtime.applyLayoutCommand({
        type: 'openAgentSessionTab',
        workspace: WORKTREE_ID,
        sessionId,
        agent: 'codex',
        tabId
      })
    ).toMatchObject({ ok: true })
  }
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: rig.root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  let spawned = 0
  const spawn = vi.fn(async () => ({
    id: `switch-pty-${++spawned}`,
    incarnationId: '33333333-3333-4333-8333-333333333333'
  }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null
  })
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({ status: 'completed', sessionId: id, sourceRetained: false })
  expect(spawn).toHaveBeenCalledOnce()
  const terminal = result.status === 'completed' ? result.terminal : undefined
  const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
    row.tabOrder.includes(terminal ?? '')
  )
  expect(group?.tabOrder).toEqual([TAB_ID, terminal, 'agent-session:later-tab'])
  const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  expect(
    published.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === terminal)
  ).toMatchObject({ replaces: { tabId: `agent-session:${id}` } })
  expect(
    session().unifiedTabs?.[WORKTREE_ID]?.some(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === id
    )
  ).toBe(false)
})

it.each([
  ['connected', 1],
  // The window may have placed it before the answer was lost: kept for the retry to adopt.
  ['timed-out', 0],
  ['viewed', 0],
  ['adopted', 0],
  ['disconnected', 0]
] as const)(
  'ends a terminal no tab will show only for a connected client, fenced and unviewed: %s',
  async (shape, discards) => {
    const { runtime } = setupMainOwnedWorkspace()
    vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: WORKTREE_ID,
      path: rig.root,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const incarnationId = '55555555-5555-4555-8555-555555555555'
    const killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    runtime.setPtyController({
      spawn: async () => ({ id: 'switch-pty', incarnationId }),
      killFenced,
      write: () => true,
      kill: () => true,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null
    })
    const spawn = runtime.spawnSwitchTerminal.bind(runtime)
    vi.spyOn(runtime, 'spawnSwitchTerminal').mockImplementation(async (...args) => ({
      ...(await spawn(...args)),
      ...(shape === 'adopted' ? { agentSessionDisposition: 'adopted' as const } : {})
    }))
    vi.spyOn(runtime, 'hasTerminalViewer').mockReturnValue(shape === 'viewed')
    vi.spyOn(runtime, 'placeSwitchTerminal').mockRejectedValue(
      shape === 'timed-out'
        ? new TerminalRevealUnconfirmedError('Terminal reveal timed out')
        : new TerminalNotPlacedError('terminal_handle_stale')
    )
    const result = await executeStructuredSessionSwitch(
      { sessionId: id, execution: { invocationId: `to-terminal-${shape}` } },
      { runtime, ...(shape === 'disconnected' ? { signal: AbortSignal.abort() } : {}) },
      'terminal'
    )
    expect(result.status).not.toBe('completed')
    if (shape === 'timed-out') {
      // It may be on screen already, so the answer is "couldn't confirm", not "try again".
      expect(result).toMatchObject({
        status: 'uncertain',
        refusal: { details: { reason: 'outcomeUnknown' } }
      })
    }
    expect(killFenced).toHaveBeenCalledTimes(discards)
    if (discards) {
      expect(killFenced).toHaveBeenCalledWith({
        id: 'switch-pty',
        expectedIncarnationId: incarnationId,
        requireNoAgentOwner: false,
        requireUnattached: false
      })
    }
  }
)

it('settles a kept source once when the switch fails after stopping it', async () => {
  const readable = await savedTranscript(rig)
  const prepare = vi.mocked(cliTranscript.prepareStructuredChatCliTranscript)
  prepare.mockReset()
  prepare.mockResolvedValueOnce(readable).mockResolvedValue({ useRealCodexHome: false })
  const { result, settled, stoppedSource } = await switchFromKeptTerminal()
  expect(result).toMatchObject({
    status: 'refused',
    refusal: { details: { reason: 'transcriptUnreadable' } }
  })
  expect(settled).toHaveBeenCalledExactlyOnceWith(stoppedSource)
})

it('settles a kept source once when its tab became a split after the stop', async () => {
  await savedTranscript(rig)
  const { result, settled, stoppedSource } = await switchFromKeptTerminal({
    afterStop: async (runtime) => {
      expect(
        await runtime.applyLayoutCommand({
          type: 'splitPane',
          workspace: WORKTREE_ID,
          tabId: TAB_ID,
          leafId: LEAF_A,
          direction: 'vertical',
          newLeafId: LEAF_B
        })
      ).toMatchObject({ ok: true })
    }
  })
  expect(result).toEqual({ status: 'completed', sessionId: id })
  expect(settled).toHaveBeenCalledExactlyOnceWith(stoppedSource)
})

it('settles a replaced source naming its chat, so the window waits for that replace', async () => {
  await savedTranscript(rig)
  const { result, settled, stoppedSource } = await switchFromKeptTerminal()
  expect(result).toEqual({ status: 'completed', sessionId: id })
  expect(settled).toHaveBeenCalledExactlyOnceWith({ ...stoppedSource, replacedBySessionId: id })
})

function holdUntilReleased() {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release }
}

it('settles a kept source once at the deadline while work after the stop is still running', async () => {
  const readable = await savedTranscript(rig)
  const prepare = vi.mocked(cliTranscript.prepareStructuredChatCliTranscript)
  const work = holdUntilReleased()
  prepare.mockReset()
  prepare.mockResolvedValueOnce(readable).mockImplementation(async () => {
    await work.held
    return readable
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { result, settled, stoppedSource } = startSwitchFromKeptTerminal()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_SWITCH_HOST_MS)
    expect(await result).toMatchObject({ refusal: { details: { reason: 'operationExpired' } } })
    expect(settled).toHaveBeenCalledExactlyOnceWith(stoppedSource)
    work.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledOnce()
  } finally {
    work.release()
    vi.useRealTimers()
  }
})

it('settles a kept source at once when its stop is proven only after the deadline', async () => {
  await savedTranscript(rig)
  const stop = holdUntilReleased()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { result, settled, stoppedSource } = startSwitchFromKeptTerminal({
      beforeStop: () => stop.held
    })
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_SWITCH_HOST_MS)
    expect(await result).toMatchObject({ refusal: { details: { reason: 'operationExpired' } } })
    expect(settled).not.toHaveBeenCalled()
    stop.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledExactlyOnceWith(stoppedSource)
  } finally {
    stop.release()
    vi.useRealTimers()
  }
})

it('settles a kept source once when an addressed close stops it but cannot retire its tab', async () => {
  const { runtime, source, incarnationId, settled, stoppedSource } = keptSourceTerminal()
  vi.spyOn(runtime, 'closeMobileSessionTab').mockResolvedValue(
    refusedMobileSessionTabClose('retirement-owner')
  )
  await expect(
    runtime.closeTerminal(source.handle, incarnationId, source.presentation)
  ).rejects.toThrow('terminal_pane_close_failed')
  // An ordinary close, not a switch: no agent to name.
  // No switch happened: the pane exits as any pane does, never with the switch's copy.
  expect(settled).toHaveBeenCalledExactlyOnceWith({ ...stoppedSource, switched: undefined })
})
