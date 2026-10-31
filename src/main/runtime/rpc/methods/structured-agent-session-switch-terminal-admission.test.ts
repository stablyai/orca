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
  TAB_ID
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import { savedTranscript } from './structured-agent-session-switch-execution.test-fixture'
import { TerminalRevealUnconfirmedError } from '../../session-tabs/terminal-not-placed-error'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'

let rig: RestTestRig
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
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

// The chat-to-terminal checks before the chat stops: readable history, and admission by the status
// store that spares only the terminal this conversation's claim owns (the one a retry adopts).

it('refuses before stopping the chat while the status store shows a CLI holding its conversation', async () => {
  await savedTranscript(rig)
  const nativeId = rig.store.getRecord(id)!.providerHandleChain.at(-1)!.handle.nativeId
  const { runtime } = setupMainOwnedWorkspace({
    runtimeDeps: {
      readHookCliWriterObservation: () => ({
        current: () => true,
        presence: async () => 'live',
        topology: 'pane-owned'
      })
    }
  })
  // The user resumed this conversation by hand in another terminal.
  vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue([
    {
      paneKey: 'other-tab:other-leaf',
      worktreeId: WORKTREE_ID,
      connectionId: null,
      agentType: 'codex',
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'done',
      prompt: '',
      providerSession: { key: 'session_id', id: nativeId }
    }
  ])
  const stop = vi.spyOn(rig.host, 'stopForSwitch')
  const spawn = vi.spyOn(runtime, 'spawnSwitchTerminal')
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal-held' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({
    status: 'refused',
    refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
  })
  expect(stop).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('refuses a chat whose saved history it cannot read before stopping the chat', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await savedTranscript(rig)
  vi.spyOn(cliTranscript, 'nativeConversationContent').mockReturnValue('saved')
  vi.mocked(cliTranscript.prepareStructuredChatCliTranscript)
    .mockReset()
    .mockResolvedValue({ useRealCodexHome: false })
  const stop = vi.spyOn(rig.host, 'stopForSwitch')
  const spawn = vi.spyOn(runtime, 'spawnSwitchTerminal')
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal-unreadable' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({
    status: 'refused',
    refusal: { details: { reason: 'transcriptUnreadable' } }
  })
  expect(stop).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('re-issuing a switch whose first answer was lost adopts the terminal it started', async () => {
  await savedTranscript(rig)
  const { runtime, session } = setupMainOwnedWorkspace()
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: rig.root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  // Answers as the daemon does: one live owner per conversation claim; a repeat adopts it.
  const owners = new ClaimedAgentPtyOwnerRegistry()
  let started = 0
  const spawn = vi.fn(async (args: Parameters<NonNullable<RuntimePtyController['spawn']>>[0]) => {
    if (!args.agentSessionEnsure) {
      throw new Error('a switch terminal carries its conversation claim')
    }
    const ensured = await owners.ensure({
      claim: args.agentSessionEnsure.claim,
      surface: args.agentSessionEnsure.surface,
      spawn: async () => ({ ptyId: `switch-pty-${++started}` })
    })
    return {
      id: ensured.owner.ptyId,
      incarnationId: '44444444-4444-4444-8444-444444444444',
      agentSessionEnsure: ensured,
      ...(ensured.disposition === 'adopted' ? { isReattach: true } : {})
    }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const { cliForkSource: source } = await cliTranscript.prepareStructuredChatCliTranscript(
    await cliTranscript.resolveStructuredChatCliSource(
      { sessionId: id, workspaceId: WORKTREE_ID },
      false
    ),
    async () => {
      throw new Error('unused')
    },
    false
  )
  const lost = await runtime.spawnSwitchTerminal(WORKTREE_ID, { agent: 'codex', source })
  const retried = await runtime.spawnSwitchTerminal(WORKTREE_ID, { agent: 'codex', source })
  expect(started).toBe(1)
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(retried).toMatchObject({
    ptyId: lost.ptyId,
    tabId: lost.tabId,
    paneKey: lost.paneKey
  })
  // The retry's own pane was withdrawn: only the source tab and the first terminal remain.
  expect(
    session()
      .tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)
      .sort()
  ).toEqual([TAB_ID, lost.tabId].sort())
})

it('a retry after an uncertain answer adopts the terminal its first attempt left, live row and all', async () => {
  await savedTranscript(rig)
  vi.spyOn(cliTranscript, 'nativeConversationContent').mockReturnValue('saved')
  const nativeId = rig.store.getRecord(id)!.providerHandleChain.at(-1)!.handle.nativeId
  const rows: AgentStatusIpcPayload[] = []
  const { runtime } = setupMainOwnedWorkspace({
    runtimeDeps: {
      readHookCliWriterObservation: () => ({
        current: () => true,
        presence: async () => 'live',
        topology: 'pane-owned'
      })
    }
  })
  vi.spyOn(runtime, 'getAgentProviderSessionRows').mockImplementation(() => rows)
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: rig.root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  // Answers as the daemon does: one live owner per conversation claim; a repeat adopts it.
  const owners = new ClaimedAgentPtyOwnerRegistry()
  let started = 0
  runtime.setPtyController({
    spawn: async (args) => {
      const ensured = await owners.ensure({
        claim: args.agentSessionEnsure!.claim,
        surface: args.agentSessionEnsure!.surface,
        spawn: async () => ({ ptyId: `switch-pty-${++started}` })
      })
      return {
        id: ensured.owner.ptyId,
        incarnationId: '44444444-4444-4444-8444-444444444444',
        agentSessionEnsure: ensured,
        ...(ensured.disposition === 'adopted' ? { isReattach: true } : {})
      }
    },
    // The registry the create adopts from, as main's PTY controller exposes it.
    findAgentSessionOwner: (claim) => owners.find(claim),
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null
  })
  const spawn = runtime.spawnSwitchTerminal.bind(runtime)
  const spawned: Awaited<ReturnType<typeof spawn>>[] = []
  vi.spyOn(runtime, 'spawnSwitchTerminal').mockImplementation(async (...args) => {
    const terminal = await spawn(...args)
    spawned.push(terminal)
    return terminal
  })
  vi.spyOn(runtime, 'placeSwitchTerminal').mockRejectedValueOnce(
    new TerminalRevealUnconfirmedError('Terminal reveal timed out')
  )
  const first = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal-lost' } },
    { runtime },
    'terminal'
  )
  expect(first).toMatchObject({ status: 'uncertain' })
  // The kept terminal's CLI reports in on the conversation.
  rows.push({
    paneKey: spawned[0]!.paneKey!,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    agentType: 'codex',
    receivedAt: 1,
    stateStartedAt: 1,
    state: 'done',
    prompt: '',
    providerSession: { key: 'session_id', id: nativeId }
  })
  const retried = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal-retry' } },
    { runtime },
    'terminal'
  )
  expect(retried).toMatchObject({ status: 'completed', sessionId: id })
  expect(started).toBe(1)
  expect(spawned.map((terminal) => terminal.ptyId)).toEqual(['switch-pty-1', 'switch-pty-1'])
})

it('refuses before stopping the chat when its claim is held in another worktree\u2019s scope', async () => {
  await savedTranscript(rig)
  vi.spyOn(cliTranscript, 'nativeConversationContent').mockReturnValue('saved')
  const nativeId = rig.store.getRecord(id)!.providerHandleChain.at(-1)!.handle.nativeId
  const { runtime } = setupMainOwnedWorkspace({
    runtimeDeps: {
      readHookCliWriterObservation: () => ({
        current: () => true,
        presence: async () => 'live',
        topology: 'pane-owned'
      })
    }
  })
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: rig.root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  // The same conversation claimed for another worktree: its CLI reports live on it. The create
  // here would refuse to adopt it (scope conflict), so the switch must refuse before the stop.
  const owners = new ClaimedAgentPtyOwnerRegistry()
  const foreign = { worktreeId: 'other-worktree', tabId: 'other-tab', leafId: 'other-leaf' }
  vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue([
    {
      paneKey: `${foreign.tabId}:${foreign.leafId}`,
      worktreeId: foreign.worktreeId,
      connectionId: null,
      agentType: 'codex',
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'done',
      prompt: '',
      providerSession: { key: 'session_id', id: nativeId }
    }
  ])
  runtime.setPtyController({
    findAgentSessionOwner: (claim) => {
      owners.register({
        claim: {
          ...claim,
          worktreeScopeDigest: `${claim.worktreeScopeDigest.startsWith('A') ? 'B' : 'A'}${claim.worktreeScopeDigest.slice(1)}`
        },
        generation: 'foreign-generation',
        phase: 'live',
        ptyId: 'foreign-pty',
        surface: { ...foreign, terminalHandle: 'foreign-handle' }
      })
      return owners.find(claim)
    },
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null
  })
  const stop = vi.spyOn(rig.host, 'stopForSwitch')
  const spawn = vi.spyOn(runtime, 'spawnSwitchTerminal')
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'to-terminal-foreign' } },
    { runtime },
    'terminal'
  )
  expect(owners.list()).toHaveLength(1)
  expect(result).toMatchObject({
    status: 'refused',
    refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
  })
  expect(stop).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})
