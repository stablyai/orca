import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'

// A Codex CLI that was never a chat, stopped mid-reply by a switch whose rollout moved during the
// stop: the switch fails, but the proven stop is kept, so a retry once the file is back reads
// the turn as the user's Stop, not as Codex failing.

const THREAD = '019a0000-0000-7000-8000-000000000001'
const SESSION = 'session-first-adoption'
const PANE = `${TAB_ID}:${LEAF_A}`

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({
    idleSweep: { intervalMs: 60_000 },
    resolveWorkspacePath: async () => rig.root
  })
  setStructuredAgentSessionHost(rig.host)
  vi.stubEnv('HOME', join(rig.root, 'home'))
  vi.stubEnv('USERPROFILE', join(rig.root, 'home'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(rig.root, 'user-data'))
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function switchParams(sessionId: string, source?: object) {
  const fields = {
    worktree: `id:${WORKTREE_ID}`,
    agent: 'codex' as const,
    resumeFrom: {
      providerSessionId: THREAD,
      cliSource: { workspaceId: WORKTREE_ID, paneKey: PANE }
    }
  }
  const envelope = {
    sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(
      () => globalThis.crypto.randomUUID(),
      rig.clock.now
    ),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.create',
      sessionId,
      fields
    })
  }
  return {
    sessionId,
    execution: {
      invocationId: sessionId,
      consented: true,
      create: { envelope, ...fields },
      ...(source ? { source } : {})
    }
  }
}

it('keeps a proven stop when the rollout moved during the stop, so a retry reads Interrupted', async () => {
  const codexHome = join(rig.root, 'codex-account')
  const transcriptPath = join(codexHome, 'sessions', '2026', '10', '31', `rollout-${THREAD}.jsonl`)
  await mkdir(dirname(transcriptPath), { recursive: true })
  const at = Date.parse('2026-10-31T12:00:00Z')
  await writeFile(
    transcriptPath,
    `${[
      { type: 'session_meta', payload: { id: THREAD, timestamp: new Date(at).toISOString() } },
      {
        timestamp: new Date(at + 1).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        timestamp: new Date(at + 2).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'A terminal prompt' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  const { runtime } = setupMainOwnedWorkspace({
    runtimeDeps: {
      prepareCodexStructuredLaunch: () => codexHome,
      resolveCodexStructuredLaunchHome: () => codexHome
    }
  })
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const pane = runtime.resolveTerminalPane(PANE, WORKTREE_ID)
  if (!pane.presentation) {
    throw new Error('missing captured source')
  }
  const row: AgentStatusIpcPayload = {
    paneKey: PANE,
    worktreeId: WORKTREE_ID,
    agentType: 'codex',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    state: 'working',
    prompt: 'A terminal prompt',
    providerSession: { key: 'session_id', id: THREAD, transcriptPath }
  }
  vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue([row])
  vi.spyOn(runtime.agentTransitions, 'latestRow').mockReturnValue(row)
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  vi.spyOn(runtime, 'assertStructuredAdoptionTerminalWritersExited').mockResolvedValue()
  vi.spyOn(runtime, 'resolveRuntimeFileTarget').mockResolvedValue({
    worktree: {
      id: WORKTREE_ID,
      repoId: 'repo-1',
      path: rig.root,
      head: 'head',
      branch: 'main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path: rig.root, head: 'head', branch: 'main', isBare: false, isMainWorktree: true }
    },
    executionHostId: 'local'
  })
  const moved = `${transcriptPath}.moved`
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    // The rollout moves while Codex is stopped, before it can record why the turn ended.
    stopAndWait: async () => {
      await rename(transcriptPath, moved)
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    },
    getForegroundProcess: async () => 'codex'
  })

  const failed = await executeStructuredSessionSwitch(
    switchParams(SESSION, {
      terminal: pane.handle,
      expectedIncarnationId: incarnationId,
      originalPresentation: pane.presentation
    }),
    { runtime },
    'chat'
  )
  expect(failed).toMatchObject({
    status: 'refused',
    refusal: { details: { reason: 'transcriptUnreadable' } }
  })
  // The chat exists at rest, holding the stop, so the retry (a new create) switches to it.
  expect(rig.store.getRecord(SESSION)).toBeTruthy()

  await rename(moved, transcriptPath)
  vi.mocked(runtime.agentTransitions.latestRow).mockReturnValue(null)
  const retried = await executeStructuredSessionSwitch(
    switchParams(`${SESSION}-retry`),
    { runtime },
    'chat'
  )
  expect(retried).toMatchObject({ status: 'completed', sessionId: SESSION })
  const { journal } = await rig.host.collaboratorsForTests().lifetime.conversation(SESSION)
  const turns = journal.snapshot().items.flatMap(({ body }) => (body.kind === 'turn' ? [body] : []))
  expect(turns).toEqual([
    expect.objectContaining({ turnId: 'cli-turn', state: 'interrupted', outcome: 'cancellation' })
  ])
})
