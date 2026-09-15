/**
 * The worker mode is a runtime implementation detail, not part of the orchestration contract.
 *
 * Two properties are pinned here, because both were false at some point in this lane:
 *
 * - a worker is TAUGHT the same thing whichever mode it runs in, byte for byte once the handle and
 *   dispatch id are normalised. The sub-dispatch section used to be withheld from a structured
 *   worker, which is a two-tier capability model dressed as a preamble tweak;
 * - a structured worker can actually BE a coordinator. `worker-start` used to resolve `--from`
 *   through `showTerminal`, which needs a PTY, so the capability the preamble withheld was in fact
 *   missing rather than merely unadvertised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../structured-worker-identity'
import { ORCHESTRATION_METHODS } from './orchestration'
import { readStructuredWorkerOutput } from './orchestration-structured-worker-lifecycle'
import { inspectWorkerTerminal } from './orchestration/worker/worker-observation'

const WORKTREE = 'repo::wt'
const STRUCTURED_HANDLE = 'structworker_worker'
const TERMINAL_HANDLE = 'term_worker'

const structuredPreambles: string[] = []

vi.mock('./orchestration/worker/worker-topology', async (importOriginal) => ({
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
  },
  releaseStructuredWorkerSession: () => {},
  discardStructuredWorkerSession: async () => {}
}))

const STRUCTURED_DEFAULT = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}
const TERMINAL_DEFAULT = { ...STRUCTURED_DEFAULT, experimentalStructuredNativeChat: false }

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
  setStructuredAgentSessionHost({
    hasSession: () => true,
    deps: {
      store: {
        getRecord: () => ({
          provider: 'claude',
          location: { executionHostId: 'local', wslDistro: null },
          lease: {
            runtimeKind: 'native',
            claimStatus: 'live',
            deathEvidence: null,
            runtimeFence: 1
          }
        })
      }
    }
  } as never)
  return paneKey
}

/** Strips the ids that legitimately differ per dispatch, leaving what the agent is taught. */
function normalizePreamble(preamble: string, handle: string, dispatchId: string): string {
  return preamble
    .split(handle)
    .join('<worker>')
    .split(dispatchId)
    .join('<dispatch>')
    .replace(/dcap_[\w-]+/g, '<capability>')
    .replace(/task_[0-9a-f]+/g, '<task>')
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
    // Deferred to the real getters for a structured handle, because resolving one through the
    // registry is exactly what is under test; stubbed only for the PTY handles that have no runtime.
    const realPaneKey = runtime.getTerminalPaneKey.bind(runtime)
    const realIncarnation = runtime.getTerminalProcessIncarnation.bind(runtime)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : (realPaneKey(handle) ?? `tab_worker:${handle}`)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => realIncarnation(handle) ?? 'runtime_test:worker:1'
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // Above the default of 1, so the sub-dispatch section is on the table for both modes; at the
    // default a depth-1 worker is refused nesting whatever mode it runs in.
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
    setStructuredAgentSessionHost(null)
    structuredWorkerIdentities.clear()
    vi.restoreAllMocks()
  })

  async function startWorker(args: {
    settings: Record<string, unknown>
    from: string
    coordinatorPaneKey: string
  }) {
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue(args.settings as never)
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

  it('teaches byte-identical instructions in both modes', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: WORKTREE,
      status: 'running'
    } as never)

    const structured = await startWorker({
      settings: STRUCTURED_DEFAULT,
      from: 'term_coord',
      coordinatorPaneKey
    })
    const terminal = await startWorker({
      settings: TERMINAL_DEFAULT,
      from: 'term_coord',
      coordinatorPaneKey
    })

    expect(structured.mode.mode).toBe('structured')
    expect(terminal.mode.mode).toBe('terminal')
    const structuredPreamble = structuredPreambles[0] as string
    const terminalPreamble = vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1] as string
    expect(normalizePreamble(structuredPreamble, STRUCTURED_HANDLE, structured.dispatchId)).toBe(
      normalizePreamble(terminalPreamble, TERMINAL_HANDLE, terminal.dispatchId)
    )
    // The section the structured lane used to withhold, asserted by name so the equality above
    // cannot pass by both preambles losing it.
    expect(structuredPreamble).toContain('=== SUB-DISPATCH ===')
  })

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
    expect(vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1]).toContain(
      '=== SUB-DISPATCH ==='
    )
  })

  it('refuses an unavailable output source without disclosing the mode', async () => {
    installStructuredCoordinator(STRUCTURED_HANDLE, 'sess_worker')
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: WORKTREE,
      status: 'running'
    } as never)
    const started = await startWorker({
      settings: STRUCTURED_DEFAULT,
      from: 'term_coord',
      coordinatorPaneKey
    })

    const read = () =>
      readStructuredWorkerOutput({
        db,
        dispatchId: started.dispatchId,
        workerState: 'ready',
        liveness: 'live',
        source: 'terminal'
      })

    expect(read).toThrow(/has no terminal output/)
    // The refusal names a source that works instead of naming the worker's kind.
    expect(read).toThrow(/--source auto or --source transcript/)
    expect(read).not.toThrow(/structured/i)
  })

  it('never claims a structured worker was checked for a human-answerable prompt', async () => {
    installStructuredCoordinator(STRUCTURED_HANDLE, 'sess_worker')
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: WORKTREE,
      status: 'running'
    } as never)
    const started = await startWorker({
      settings: STRUCTURED_DEFAULT,
      from: 'term_coord',
      coordinatorPaneKey
    })

    const observation = await inspectWorkerTerminal(runtime, db, started.dispatchId)

    // Absent, not null: null is the contract's "looked and found none", and a journal question is
    // invisible to every prompt scan, so null would be a false negative a coordinator acts on.
    expect('agentWait' in observation).toBe(false)
  })
})
