import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
/** Both worker modes receive identical orchestration instructions after identity/surface normalization, and structured workers can dispatch sub-workers through session authority. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'

import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import '../../../../orchestration/workers/launch/worker-dispatch-preamble'
import { ORCHESTRATION_METHODS } from '../orchestration'
import './orchestration-structured-worker-lifecycle'
import '../worker/observation/worker-observation'

const WORKTREE = 'repo::wt'
const STRUCTURED_HANDLE = 'structworker_worker'
const TERMINAL_HANDLE = 'term_worker'

const structuredPreambles: string[] = []
// The session host the code under test reads; a structural fake, so no host type is claimed.
const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))

vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

vi.mock('../worker/start/placement/worker-placement-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStructuredWorkerSessionForWorktree: async (args: { effects: unknown[] }) => {
    args.effects.push({ kind: 'terminal', role: 'agent', action: 'created' })
    return { identity: { handle: STRUCTURED_HANDLE, sessionId: 'sess_worker' }, host: {} }
  },
  createExistingWorktreeWorkerTerminal: async () => ({ handle: TERMINAL_HANDLE })
}))
vi.mock('./orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: async (args: { preamble: string }) => {
    structuredPreambles.push(args.preamble)
    return 'accepted'
  },
  releaseStructuredWorkerSession: () => {},
  discardStructuredWorkerSession: async () => {}
}))

const STRUCTURED_DEFAULT = {
  nativeChatProviders: EVERY_AGENT_CHAT,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}
const TERMINAL_DEFAULT = { ...STRUCTURED_DEFAULT, nativeChatProviders: {} }

/** A coordinator that IS a structured session: registry identity plus a live durable record. */
function installStructuredCoordinator(handle: string, sessionId: string): string {
  const paneKey = mintStructuredWorkerPaneKey(sessionId)
  structuredWorkerIdentities.register({
    handle,
    sessionId,
    agent: 'claude',
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(sessionId),
    worktreeId: WORKTREE,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  hostRef.current = {
    hasSession: () => true,
    deps: {
      store: {
        getConversation: () =>
          agentSessionConversationView(
            agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeFence: 1 }))
          ),
        // No committed /clear: each session is its own lineage's root.
        listConversations: () => []
      }
    }
  }
  return paneKey
}

describe('a worker cannot tell which mode it is running in', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    structuredPreambles.length = 0
    structuredWorkerIdentities.clear()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // Use real structured-handle getters to test registry resolution; stub only PTYs lacking runtime state.
    const realPaneKey = runtime.getTerminalPaneKey.bind(runtime)
    const realIncarnation = runtime.getTerminalProcessIncarnation.bind(runtime)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : (realPaneKey(handle) ?? `tab_worker:${handle}`)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => realIncarnation(handle) ?? 'runtime_test:worker:1'
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // Raise nesting depth above one so both modes can receive sub-dispatch instructions.
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: WORKTREE,
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => {
    db.close()
    hostRef.current = null
    structuredWorkerIdentities.clear()
    vi.restoreAllMocks()
  })

  async function startWorker(args: {
    settings: Record<string, unknown>
    from: string
    coordinatorPaneKey: string
  }) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mode selection reads only getSettings; all worker execution surfaces are stubbed below.
    vi.spyOn(runtime, 'requireStore').mockReturnValue({ getSettings: () => args.settings } as never)
    const runId = db.createRun({
      objective: 'mode opacity',
      coordinatorHandle: args.from,
      coordinatorPaneKey: args.coordinatorPaneKey
    }).id
    const task = db.createTask({ spec: 'do the thing', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )!
    const result = (await method.handler(
      method.params!.parse({
        task: task.id,
        from: args.from,
        worktree: 'current',
        agent: 'claude'
      }),
      { runtime }
    )) as { state: string; dispatchId: string; mode: { mode: string } }
    return result
  }

  it('lets a structured worker dispatch a sub-worker like any other coordinator', async () => {
    const paneKey = installStructuredCoordinator('structworker_coord', 'sess_coord')
    // Proves the resolution is not falling through to a PTY: showTerminal cannot answer here.
    const showTerminal = vi
      .spyOn(runtime, 'showTerminal')
      .mockRejectedValue(new Error('no_active_terminal'))

    const result = await startWorker({
      settings: TERMINAL_DEFAULT,
      from: 'structworker_coord',
      coordinatorPaneKey: paneKey
    })

    expect(result).toMatchObject({ state: 'ready' })
    expect(showTerminal).not.toHaveBeenCalled()
    // Its sub-worker is told the coordinator's Orca session ID, not the handle it was minted.
    expect(vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1]).toContain(
      "Your coordinator's Orca session ID is: orca_session_id:sess_coord\n"
    )
    expect(vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1]).toContain(
      '=== SUB-DISPATCH ==='
    )
  })
})
