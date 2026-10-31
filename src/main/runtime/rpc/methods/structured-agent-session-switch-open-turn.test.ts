import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
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
  PTY_A
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import * as legacyImport from '../../../native-chat/agent-session-journal/journal-legacy-import'

vi.mock('../../../native-chat/agent-session-journal/journal-legacy-import', async (load) => {
  const actual = await load<typeof legacyImport>()
  return { ...actual, prepareLegacyTranscriptImport: vi.fn(actual.prepareLegacyTranscriptImport) }
})

// A terminal whose CLI turn never recorded its end (killed, crashed, or stopped before the write):
// once the census proves no CLI writer is left and the chat's own owner is at rest, the chat
// shows that turn as over, so it never reads as replying forever.

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, { location: { ...params.location, workspaceId: WORKTREE_ID } })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

async function openCliTurn() {
  await rig.host.switchToChat(id)
  await rig.host.switchToTerminal(id)
  const record = rig.store.getRecord(id)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const codexHome = join(rig.root, 'codex-account')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  const filePath = join(codexHome, 'sessions', 'switch-source.jsonl')
  const nativeId = head.handle.nativeId
  // After the chat's import, which is stamped at the run's real time.
  const at = Date.parse('2999-01-01T00:00:00Z')
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: new Date(at).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        timestamp: new Date(at + 1).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'A terminal prompt' }
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

it('settles a CLI turn left open once no writer is left, after the census', async () => {
  await openCliTurn()
  const { runtime } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const written = vi.fn(() => true)
  runtime.setPtyController({
    write: written,
    kill: () => false,
    stopAndWait: async () => {
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    },
    // The CLI sits at its prompt: the switch stops the process without an Escape.
    getForegroundProcess: async () => 'codex'
  })
  const order: string[] = []
  const census = vi
    .spyOn(runtime, 'assertStructuredAdoptionTerminalWritersExited')
    .mockImplementation(async () => void order.push('census'))
  const refresh = rig.host.refreshSwitchTranscript
  let legacyParses = 0
  const refreshed = vi
    .spyOn(rig.host, 'refreshSwitchTranscript')
    .mockImplementation(async (...args) => {
      order.push('import')
      const before = vi.mocked(legacyImport.prepareLegacyTranscriptImport).mock.calls.length
      await refresh(...args)
      legacyParses +=
        vi.mocked(legacyImport.prepareLegacyTranscriptImport).mock.calls.length - before
    })
  const answer = await executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'open-turn',
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
  expect(answer).toEqual({ status: 'completed', sessionId: id })
  expect(order).toEqual(['census', 'import'])
  expect(written).not.toHaveBeenCalled()
  expect(census).toHaveBeenCalledWith('codex', expect.any(String), expect.anything())
  expect(refreshed.mock.calls[0]?.[5]).toBe(true)
  // Codex's resting importer is its one reader: no second, unused parse of the whole transcript.
  expect(legacyParses).toBe(0)
  const { journal } = await rig.host.collaboratorsForTests().lifetime.conversation(id)
  const turns = journal
    .snapshot()
    .items.flatMap(({ body }) => (body.kind === 'turn' ? [body] : []))
    .filter((turn) => turn.turnId === 'cli-turn')
  expect(turns).toEqual([expect.objectContaining({ state: 'interrupted' })])
  expect(turns[0]).not.toHaveProperty('outcome')
})

it.each([false, true])(
  'refuses a replying terminal agent without consent, stopping nothing (replying from the start=%s)',
  async (fromStart) => {
    await openCliTurn()
    const { runtime } = setupMainOwnedWorkspace()
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing captured source')
    }
    const written = vi.fn(() => true)
    const stopped = vi.fn(async () => true)
    runtime.setPtyController({
      write: written,
      kill: () => false,
      stopAndWait: stopped,
      getForegroundProcess: async () => 'codex'
    })
    // Idle when the request arrives, replying by the time the stop would be admitted; or replying
    // already, refused before the transcript is read.
    let replying = fromStart
    vi.spyOn(runtime.agentTransitions, 'latestRow').mockImplementation((paneKey) =>
      replying
        ? {
            state: 'working',
            prompt: '',
            paneKey,
            connectionId: null,
            receivedAt: 0,
            stateStartedAt: 0
          }
        : null
    )
    const prepare = vi.mocked(cliTranscript.prepareStructuredChatCliTranscript)
    const readable = prepare.getMockImplementation()!
    prepare.mockImplementation(async (...args) => {
      replying = true
      return readable(...args)
    })
    const answer = await executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'consent-left-to-host',
          consented: false,
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
    expect(answer).toMatchObject({
      status: 'refused',
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
    })
    expect(written).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(fromStart ? 0 : 1)
  }
)
