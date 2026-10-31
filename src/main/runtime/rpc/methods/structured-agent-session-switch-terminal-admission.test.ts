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
import {
  executionOwnerRig,
  ownerOf,
  type ExecutionOwnerRig
} from './structured-agent-session-switch-terminal-admission.test-fixture'
import type { AgentSessionExecutionClaim } from '../../../../shared/agent-session-host-authority'

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
let owner: ExecutionOwnerRig | undefined
afterEach(async () => {
  await owner?.dispose()
  owner = undefined
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

// The chat-to-terminal checks before the chat stops: readable history, the create's own ownership
// decision, and admission by the status store that spares only the terminal that decision adopts.

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

async function switchRig(opts: Parameters<typeof executionOwnerRig>[1] = {}) {
  await savedTranscript(rig)
  vi.spyOn(cliTranscript, 'nativeConversationContent').mockReturnValue('saved')
  const nativeId = rig.store.getRecord(id)!.providerHandleChain.at(-1)!.handle.nativeId
  owner = executionOwnerRig({ host: rig.host, root: rig.root, nativeId }, opts)
  return owner
}

/** A first attempt whose reveal timed out: its terminal T1 stays, and its CLI reports in live. */
async function lostFirstAttempt(r: ExecutionOwnerRig) {
  r.place.mockRejectedValueOnce(new TerminalRevealUnconfirmedError('Terminal reveal timed out'))
  expect(await r.run('to-terminal-lost')).toMatchObject({ status: 'uncertain' })
  const t1 = r.spawned[0]!
  r.row(t1.paneKey!)
  return t1
}

it.each([
  { route: 'daemon, after main relaunched', listsOwners: true, relaunch: true },
  {
    route: 'daemon, after main relaunched, registry full',
    listsOwners: true,
    relaunch: true,
    full: true
  },
  { route: 'in-process, its listing names no owners', listsOwners: false, relaunch: false }
])('a retry after a lost answer adopts the first attempt\u2019s terminal ($route)', async (c) => {
  const r = await switchRig({ listsOwners: c.listsOwners })
  const t1 = await lostFirstAttempt(r)
  const claim = r.owners()[0]!.claim
  if (c.relaunch) {
    r.relaunch()
  }
  if (c.full) {
    for (let index = 0; index < 1023; index++) {
      r.list(ownerOf({ ...claim, identityDigest: `other-${index}` }, `other-pty-${index}`))
    }
  }
  const retried = await r.run('to-terminal-retry')
  expect(retried).toMatchObject({ status: 'completed', sessionId: id, terminal: t1.tabId })
  expect(r.started()).toBe(1)
  expect(r.spawned.map((terminal) => terminal.ptyId)).toEqual([t1.ptyId, t1.ptyId])
  expect(r.place.mock.calls.map(([, args]) => [args.chatSessionId, args.terminal.ptyId])).toEqual([
    [id, t1.ptyId],
    [id, t1.ptyId]
  ])
})

const foreign = (claim: AgentSessionExecutionClaim) => ({
  ...claim,
  worktreeScopeDigest: 'foreign'
})
it.each([
  {
    held: 'another worktree\u2019s terminal whose agent exited',
    code: 'agent_session_conflict',
    seed: (claim: AgentSessionExecutionClaim, r: ExecutionOwnerRig) => {
      r.list(ownerOf(foreign(claim), 'foreign-pty'))
      r.row('foreign-pty-tab:foreign-pty-leaf', 'other-worktree', 'exited')
    }
  },
  {
    held: 'two terminals (a recorded conflict)',
    code: 'agent_session_conflict',
    seed: (claim: AgentSessionExecutionClaim, r: ExecutionOwnerRig) => {
      r.list(ownerOf(claim, 'conflict-a'))
      r.list(ownerOf(claim, 'conflict-b'))
    }
  },
  {
    held: 'another worktree\u2019s create still starting',
    code: 'agent_session_conflict',
    seed: (claim: AgentSessionExecutionClaim, r: ExecutionOwnerRig) =>
      r.pendingCreate(foreign(claim))
  },
  {
    held: 'an unreadable ownership listing',
    code: 'agent_session_owner_restart_failed',
    seed: (_claim: AgentSessionExecutionClaim, r: ExecutionOwnerRig) => r.failListing()
  },
  {
    held: 'no room for a fresh owner',
    code: 'agent_session_owner_restart_failed',
    seed: (claim: AgentSessionExecutionClaim, r: ExecutionOwnerRig) => {
      for (let index = 0; index < 1024; index++) {
        r.list(ownerOf({ ...claim, identityDigest: `other-${index}` }, `other-pty-${index}`))
      }
    }
  }
])('refuses before stopping the chat where its create would refuse: $held', async (c) => {
  const r = await switchRig({ seed: (claim) => c.seed(claim, r) })
  const result = await r.run('to-terminal-refused')
  expect(result).toMatchObject({ status: 'refused', refusal: { code: c.code } })
  expect(r.stop).not.toHaveBeenCalled()
  expect(r.spawned).toEqual([])
  expect(r.started()).toBe(0)
  expect(r.place).not.toHaveBeenCalled()
})

it.each([
  { control: 'another live holder beside that terminal', supportsClaims: true },
  { control: 'an execution owner that cannot attest claims', supportsClaims: false }
])('the status store still refuses a retry: $control', async (c) => {
  const r = await switchRig({ supportsClaims: c.supportsClaims })
  await lostFirstAttempt(r)
  if (c.supportsClaims) {
    r.row('other-tab:other-leaf')
  }
  expect(await r.run('to-terminal-retry')).toMatchObject({
    status: 'refused',
    refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
  })
  expect(r.stop).toHaveBeenCalledTimes(1)
  expect(r.started()).toBe(1)
})

it.each([
  { change: 'the first attempt\u2019s terminal exits', completes: true },
  { change: 'another worktree takes the conversation', completes: false }
])('the spawn decides again when, during the stop, $change', async (c) => {
  const r = await switchRig()
  const t1 = await lostFirstAttempt(r)
  const claim = r.owners()[0]!.claim
  const stop = rig.host.stopForSwitch.bind(rig.host)
  r.stop.mockImplementationOnce(async (...args) => {
    r.exit(t1.ptyId!)
    if (!c.completes) {
      r.list(ownerOf(foreign(claim), 'foreign-pty'))
    }
    return stop(...args)
  })
  const retried = await r.run('to-terminal-retry')
  expect(retried).toMatchObject({ status: c.completes ? 'completed' : 'refused' })
  // Never the stale terminal, never two owners of the claim; a refusal keeps the source tab.
  expect(r.spawned.map((terminal) => terminal.ptyId)).toEqual(
    c.completes ? [t1.ptyId, 'switch-pty-2'] : [t1.ptyId]
  )
  expect(r.owners().map((listed) => listed.ptyId)).toEqual([
    c.completes ? 'switch-pty-2' : 'foreign-pty'
  ])
  expect(r.place).toHaveBeenCalledTimes(c.completes ? 2 : 1)
})
