import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import * as mobileProjection from '../../runtime-mobile-session-projection'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
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
import { DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

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
async function savedTranscript(sessionId = id) {
  await rig.host.switchToChat(sessionId)
  await rig.host.switchToTerminal(sessionId)
  const record = rig.store.getRecord(sessionId)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const codexHome = join(rig.root, 'codex-account')
  const sessions = join(codexHome, 'sessions')
  await mkdir(sessions, { recursive: true })
  const filePath = join(sessions, 'switch-source.jsonl')
  const nativeId = head.handle.nativeId
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: '2026-10-26T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'A terminal prompt'
        }
      },
      {
        timestamp: '2026-10-26T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'cli-turn' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host: rig.host,
    record,
    head,
    agent: 'codex',
    cwd: rig.root,
    providerSessionId: nativeId,
    requireCurrent: vi.fn(),
    metadata: structuredAgentRuntimeMetadata('codex')!
  })
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
    useRealCodexHome: false,
    cliForkSource: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath,
      cwd: rig.root,
      codexHome,
      executionHostPlatform: process.platform
    }
  })
}

it.each(['single', 'split', 'other-workspace'] as const)(
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
    await savedTranscript(sessionId)
    const { runtime, session } = setupMainOwnedWorkspace({ split: shape === 'split' })
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
    const originalSourceTabs = structuredClone(session().tabsByWorktree[WORKTREE_ID])
    const originalSourceLayout = structuredClone(session().terminalLayoutsByTabId[TAB_ID])
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
    expect(group?.activeTabId).toBe(savedDestination)
    if (existingDestination) {
      expect(
        session().unifiedTabs?.[destinationWorkspace]?.find(
          (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
        )?.id
      ).toBe(existingDestination.tabId)
    }
    const published = await runtime.listMobileSessionTabs(`id:${destinationWorkspace}`)
    expect(published.activeTabId).toBe(destination)
    expect(published.tabs.find((tab) => tab.id === destination)).toMatchObject({
      openPlacement: {
        invocationId: 'from-pane',
        generation: expect.any(String),
        placement: elsewhere ? {} : { afterTabId: TAB_ID, index: 0 },
        ...(elsewhere ? {} : { source: source.presentation.identity })
      }
    })
    if (elsewhere) {
      const destinationTab = published.tabs.find(
        (tab) => tab.type === 'agent-session' && tab.id === destination
      )
      expect(
        destinationTab?.type === 'agent-session' && destinationTab.openPlacement?.source
      ).toBeUndefined()
      expect(session().tabsByWorktree[WORKTREE_ID]).toEqual(originalSourceTabs)
      expect(session().terminalLayoutsByTabId[TAB_ID]).toEqual(originalSourceLayout)
      expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'terminal', parentTabId: TAB_ID })])
      )
      expect(rig.store.getRecord(sessionId)?.location.workspaceId).toBe(destinationWorkspace)
    }
    const layout = session().terminalLayoutsByTabId[TAB_ID]
    if (split) {
      expect(layout?.ptyIdsByLeafId?.[LEAF_B]).toBe(PTY_B)
      expect(layout?.root).toEqual({ type: 'leaf', leafId: LEAF_B })
    } else if (!elsewhere) {
      expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(false)
    }
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('keeps the stopped source when destination publication fails before retirement', async () => {
  await savedTranscript()
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
  expect(session().tabsByWorktree[WORKTREE_ID]).toEqual(originalSourceTabs)
  expect(session().terminalLayoutsByTabId[TAB_ID]).toEqual(originalSourceLayout)
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})

it('does not acquire or retire a terminal whose physical stop is unproven', async () => {
  await savedTranscript()
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
  vi.spyOn(runtime, 'createSessionSwitchTerminal').mockRejectedValue(
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

it.each([
  { navigate: false, viewerSelection: undefined },
  { navigate: true, viewerSelection: undefined },
  { navigate: false, viewerSelection: 'selection-v1:initiating-viewer' }
])(
  'captures selection before native Stop and consumes it at the ordinary terminal snapshot: $navigate/$viewerSelection',
  async ({ navigate, viewerSelection }) => {
    const { runtime, bindPty, handleOf, session } = setupMainOwnedWorkspace()
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: WORKTREE_ID,
        path: rig.root,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: id,
      agent: 'codex',
      activate: true,
      check: () => {}
    })
    const other = createTestParams()
    expect(
      await rig.host.create(caller, {
        ...other,
        envelope: { ...other.envelope, sessionId: 'newer-navigation' },
        location: { ...other.location, workspaceId: WORKTREE_ID }
      })
    ).toMatchObject({ ok: true })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: 'newer-navigation',
      agent: 'codex',
      activate: false
    })
    await rig.host.switchToChat(id)
    const nativeIdentity = agentSessionProviderHandleChainHead(
      rig.store.getRecord(id)!.providerHandleChain
    )!.handle
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const close = rig.adapter.closeSession.getMockImplementation()!
    rig.adapter.closeSession.mockImplementation(async (...args) => {
      stopping.resolve()
      await stopped.promise
      return close(...args)
    })
    const receiverExit = Promise.withResolvers<void>()
    releaseReceiverExit = () => receiverExit.resolve()
    let ordinaryCreates = 0
    const stopForSwitch = vi.spyOn(rig.host, 'stopForSwitch')
    const spawn = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_selector, opts = {}) => {
        ordinaryCreates += 1
        if (!opts.tabId || !opts.leafId) {
          throw new Error('missing ordinary published pane')
        }
        if (!navigate && !viewerSelection && ordinaryCreates === 1) {
          void rig.host.trackSwitchPhysical(id, receiverExit.promise)
        }
        opts.beforePtySpawn?.()
        opts.onPtySpawnDispatched?.({
          tabId: opts.tabId,
          leafId: opts.leafId,
          launchAgent: 'codex',
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
        })
        const ptyId = ordinaryCreates === 1 ? 'switch-destination' : 'switch-destination-next'
        bindPty({
          worktreeId: WORKTREE_ID,
          tabId: opts.tabId,
          leafId: opts.leafId,
          ptyId
        })
        runtime.registerPty(ptyId, WORKTREE_ID, null, {
          tabId: opts.tabId,
          leafId: opts.leafId,
          terminalHandle: opts.preAllocatedHandle
        })
        return {
          handle: handleOf(ptyId),
          ptyId,
          tabId: opts.tabId,
          paneKey: `${opts.tabId}:${opts.leafId}`,
          worktreeId: WORKTREE_ID,
          title: null,
          surface: 'background'
        }
      })
    const operation = executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'ordinary-native-stop',
          sourceTabId: `agent-session:${id}`,
          ...(viewerSelection ? { viewerSelection } : {})
        }
      },
      { runtime },
      'terminal'
    )
    await Promise.race([
      stopping.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(spawn).not.toHaveBeenCalled()
    runtime.projectStructuredAgentSessionTab({
      workspaceId: 'another-workspace',
      sessionId: 'automatic-publication',
      agent: 'codex',
      activate: true
    })
    if (navigate) {
      const picked = await runtime.activateMobileSessionTab(
        `id:${WORKTREE_ID}`,
        'agent-session:newer-navigation',
        undefined,
        { navigation: 'all', intent: 'user', clientNavigationId: 'host-follow-viewer' }
      )
      expect(picked.activeTabId).toBe('agent-session:newer-navigation')
    }
    const outstanding =
      !navigate && !viewerSelection
        ? executeStructuredSessionSwitch(
            {
              sessionId: id,
              execution: {
                invocationId: 'outstanding-duplicate',
                sourceTabId: `agent-session:${id}`
              }
            },
            { runtime },
            'terminal'
          )
        : undefined
    const replay =
      !navigate && !viewerSelection
        ? executeStructuredSessionSwitch(
            {
              sessionId: id,
              execution: {
                invocationId: 'ordinary-native-stop',
                sourceTabId: `agent-session:${id}`
              }
            },
            { runtime },
            'terminal'
          )
        : undefined
    stopped.resolve()
    const answer = await operation
    if (outstanding) {
      expect(await outstanding).toEqual(answer)
    }
    if (replay) {
      expect(await replay).toEqual(answer)
    }
    expect(answer).toMatchObject({ status: 'completed' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![1]!.presentation).toBe('background')
    expect(spawn.mock.calls[0]![1]!.agentLaunchViewer?.()).toBe('none')
    const snapshot = await runtime.listMobileSessionTabs(
      `id:${WORKTREE_ID}`,
      navigate ? 'host-follow-viewer' : undefined
    )
    if (viewerSelection) {
      expect(
        snapshot.tabs.find(
          (tab): tab is RuntimeMobileSessionTerminalClientTab =>
            tab.type === 'terminal' && tab.ptyId === 'switch-destination'
        )?.openPlacement
      ).toMatchObject({
        activate: true,
        viewerSelection
      })
    }
    expect(snapshot.activeTabId).toBe(
      navigate
        ? 'agent-session:newer-navigation'
        : viewerSelection
          ? `agent-session:${id}`
          : `${spawn.mock.calls[0]![1]!.tabId}::${spawn.mock.calls[0]![1]!.leafId}`
    )
    if (!navigate && !viewerSelection) {
      const request = (invocationId: string) =>
        executeStructuredSessionSwitch(
          {
            sessionId: id,
            execution: { invocationId, sourceTabId: `agent-session:${id}` }
          },
          { runtime },
          'terminal'
        )
      if (answer.status !== 'completed' || !answer.terminal) {
        receiverExit.resolve()
        throw new Error('missing completed destination')
      }
      const picked = await runtime.activateMobileSessionTab(
        `id:${WORKTREE_ID}`,
        'agent-session:newer-navigation',
        undefined,
        { navigation: 'all', intent: 'user', clientNavigationId: 'host-follow-viewer' }
      )
      expect(picked.activeTabId).toBe('agent-session:newer-navigation')
      const projection = vi.spyOn(mobileProjection, 'projectRuntimeMobileSessionTabs')
      expect(await request('ordinary-native-stop')).toEqual(answer)
      expect(await request('already-published-physical-join')).toEqual(answer)
      expect(projection).not.toHaveBeenCalled()
      expect(
        (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`, 'host-follow-viewer')).activeTabId
      ).toBe('agent-session:newer-navigation')
      expect(spawn).toHaveBeenCalledOnce()
      expect(stopForSwitch).toHaveBeenCalledOnce()
      try {
        expect(rig.host.switchExecuting(id)).toBe(true)
        await runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, answer.terminal, {
          reason: 'user'
        })
        expect(runtime.currentSessionSwitchDestination(WORKTREE_ID, answer)).toBe(false)
        expect(await request('missing-but-physically-unsettled')).toEqual(answer)
        expect(spawn).toHaveBeenCalledOnce()
        expect(stopForSwitch).toHaveBeenCalledOnce()
      } finally {
        receiverExit.resolve()
      }
      await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false))
      const unknown = vi
        .spyOn(runtime, 'currentSessionSwitchDestination')
        .mockReturnValue(undefined)
      expect(await request('unknown-destination')).toMatchObject({
        status: 'refused',
        refusal: { code: 'agent_session_ownership_unknown' }
      })
      expect(spawn).toHaveBeenCalledOnce()
      expect(await request('ordinary-native-stop')).toEqual(answer)
      expect(unknown).toHaveBeenCalledOnce()
      unknown.mockRestore()
      expect(spawn).toHaveBeenCalledOnce()
      expect(stopForSwitch).toHaveBeenCalledOnce()
      const replacement = await request('fresh-history-after-close')
      expect(replacement).toMatchObject({ status: 'completed', sessionId: id })
      expect(replacement).not.toMatchObject({ terminal: answer.terminal })
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(runtime.currentSessionSwitchDestination(WORKTREE_ID, replacement)).toBe(true)
      await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false))
      await runtime.activateMobileSessionTab(
        `id:${WORKTREE_ID}`,
        'agent-session:newer-navigation',
        undefined,
        { navigation: 'all', intent: 'user', clientNavigationId: 'host-follow-viewer' }
      )
      expect(await request('surviving-destination')).toEqual(replacement)
      expect(
        (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`, 'host-follow-viewer')).activeTabId
      ).toBe('agent-session:newer-navigation')
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(stopForSwitch).toHaveBeenCalledTimes(2)
      expect(
        agentSessionProviderHandleChainHead(rig.store.getRecord(id)!.providerHandleChain)!.handle
      ).toEqual(nativeIdentity)
      expect(rig.adapter.dispatch).not.toHaveBeenCalled()
      if (replacement.status !== 'completed' || !replacement.terminal) {
        throw new Error('missing completed replacement')
      }
      const destinationId = replacement.terminal
      for (const size of [10, 100]) {
        for (
          let index = runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)!.tabs.length;
          index < size;
          index += 1
        ) {
          const sessionId = `inventory-${index}`
          expect(
            await runtime.applyLayoutCommand({
              type: 'openAgentSessionTab',
              workspace: WORKTREE_ID,
              sessionId,
              agent: 'codex',
              tabId: `agent-session:${sessionId}`
            })
          ).toMatchObject({ ok: true })
          runtime.projectStructuredAgentSessionTab({
            workspaceId: WORKTREE_ID,
            sessionId,
            agent: 'codex',
            activate: false
          })
          runtime.projectStructuredAgentSessionTab({
            workspaceId: 'repo-1::/inventory-elsewhere',
            sessionId,
            agent: 'codex',
            activate: false
          })
        }
        const held = runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)!
        const unrelated = runtime.mobileSessionTabsByWorktree.get('repo-1::/inventory-elsewhere')!
        const rows = held.tabs
        const otherRows = unrelated.tabs
        const saved = session().unifiedTabs![WORKTREE_ID]!
        const destination = rows.find((tab) => tab.type === 'terminal' && tab.id === destinationId)
        if (!destination) {
          throw new Error('missing completed destination')
        }
        const counts = { rows: 0, identity: 0, decorations: 0, saved: 0, unrelated: 0 }
        held.tabs = new Proxy(
          [...rows.filter((tab) => tab !== destination), destination].map(
            (tab) =>
              new Proxy(tab, {
                get(target, key, receiver) {
                  if (key === 'type' || key === 'id' || key === 'sessionId') {
                    counts.identity += 1
                  } else if (typeof key === 'string') {
                    counts.decorations += 1
                  }
                  // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards raw string|symbol keys with the original receiver.
                  return Reflect.get(target, key, receiver)
                }
              })
          ),
          {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                counts.rows += 1
              }
              // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards raw string|symbol keys with the original receiver.
              return Reflect.get(target, key, receiver)
            }
          }
        )
        session().unifiedTabs![WORKTREE_ID] = new Proxy(saved, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              counts.saved += 1
            }
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards raw string|symbol keys with the original receiver.
            return Reflect.get(target, key, receiver)
          }
        })
        unrelated.tabs = new Proxy(otherRows, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              counts.unrelated += 1
            }
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards raw string|symbol keys with the original receiver.
            return Reflect.get(target, key, receiver)
          }
        })
        try {
          projection.mockClear()
          expect(await request('fresh-history-after-close')).toEqual(replacement)
          expect(counts).toEqual({ rows: 0, identity: 0, decorations: 0, saved: 0, unrelated: 0 })
          expect(await request(`scale-completed-${size}`)).toEqual(replacement)
          expect(counts.rows).toBe(size)
          expect(counts.rows + counts.identity).toBeLessThanOrEqual(3 * size)
          expect({
            decorations: counts.decorations,
            saved: counts.saved,
            unrelated: counts.unrelated
          }).toEqual({ decorations: 0, saved: 0, unrelated: 0 })
          expect(projection).not.toHaveBeenCalled()
        } finally {
          held.tabs = rows
          session().unifiedTabs![WORKTREE_ID] = saved
          unrelated.tabs = otherRows
        }
      }
    }
  }
)
