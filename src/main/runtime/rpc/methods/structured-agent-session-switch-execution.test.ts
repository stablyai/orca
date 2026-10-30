import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
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
    if (!split && !elsewhere) {
      // A whole tab is replaced in the one write: its rows are gone from the published snapshot.
      expect(
        published.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === TAB_ID)
      ).toBe(false)
    }
    if (elsewhere) {
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
