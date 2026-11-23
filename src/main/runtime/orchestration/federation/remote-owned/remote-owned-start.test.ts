import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { prepareWorkerStart } from '../../../rpc/methods/orchestration/worker/worker-start-method'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { getRemotePlacement } from '../../db/remote-owned/remote-placements'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import { remoteServerPin } from '../../db/remote-owned/remote-run-links'
import { OrchestrationDb } from '../../db/orchestration-db'
import { startsInChatLineage } from '../../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import {
  forwardedChatLineage,
  serverStartOptions,
  startRemoteOwnedWorker
} from './remote-owned-start'

type Runtime = Parameters<typeof forwardedChatLineage>[0]
type Params = Parameters<typeof forwardedChatLineage>[2]
type Caller = Parameters<typeof forwardedChatLineage>[3]

const server = { environmentId: 'env-1', name: 'server', peerFingerprint: 'peer-1' }
// No --from: the creator resolves to none, so only the flag itself could make this a lineage.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage read and the option filter read only these fields.
const params = { spec: 'work', on: 'server', chatLineage: true } as Params

/** Reads the agent-home list and answers the server's status probe; nothing else of the runtime. */
function runtimeWith(serverCapabilities: string[]): Runtime {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage read and the capability probe use only these members.
  return {
    bots: { list: () => [{ folderWorkspaceId: 'home-1' }] },
    callOrchestrationWorkerServer: async () => ({
      runtimeId: 'server-runtime',
      capabilities: serverCapabilities
    })
  } as unknown as Runtime
}

function session(workspaceId: string): Caller {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership reads only the session's workspace.
  return { sessionId: 'session-1', workspaceId } as unknown as Caller
}

describe('a chat-lineage start on a paired server', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('carries the lineage only to a server that takes it, and only for a lineage caller', async () => {
    const home = session('folder:home-1')
    const takes = runtimeWith([ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY])
    expect(await forwardedChatLineage(takes, db, params, home, server)).toEqual({
      chatLineage: true
    })
    expect(await forwardedChatLineage(runtimeWith([]), db, params, home, server)).toEqual({})
    // A caller outside any lineage cannot claim one by sending the flag itself.
    const elsewhere = session('folder:elsewhere')
    expect(await forwardedChatLineage(takes, db, params, elsewhere, server)).toEqual({})
    expect(serverStartOptions(params)).not.toHaveProperty('chatLineage')
    expect(serverStartOptions(params)).toMatchObject({ spec: 'work' })
  })

  it('is honoured on the server only from the paired Orca coordinating the Run', () => {
    const runtime = runtimeWith([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the caller kind is read for a paired claim.
    const peer = { kind: 'peer' } as Caller
    const claim = { chatLineage: true } as const
    expect(startsInChatLineage(runtime, db, claim, peer)).toBe(true)
    expect(startsInChatLineage(runtime, db, claim, session('folder:elsewhere'))).toBe(false)
    expect(startsInChatLineage(runtime, db, {}, peer)).toBe(false)
  })
})

const DEFAULT_SELECTION = { agent: 'codex', source: 'project', projectId: 'project-b' } as const
const StartedDefault = z.object({
  runId: z.string(),
  taskId: z.string(),
  dispatchId: z.string(),
  agent: z.string(),
  agentSelection: z.object({ agent: z.string(), source: z.string(), projectId: z.string() })
})

describe('remote default admission and durable selection', () => {
  let directory: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let defaultChoice: 'codex' | 'claude' | 'blank' | 'unavailable' | 'unsupported'
  const remote = {
    environmentId: 'env_b',
    name: 'devB',
    peerFingerprint: 'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU',
    homePeerFingerprint: 'd9b49845ccf7825b16d8a6026f24f283a700ec94ad6e750e0ff344db365934a0',
    pairingRevision: 1
  }
  const pane = 'tab_coord:11111111-1111-4111-8111-111111111111'
  const target = {
    from: 'term_coord',
    on: 'devB',
    spec: 'build it',
    worktree: 'new-top-level',
    repo: 'id:repo-b',
    agent: 'default'
  }
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => remote,
    hasEnvironment: () => true,
    call: async (_selector, method, params, _timeout, _envelope, _revision, send) => {
      const ok = (result: unknown) => ({
        id: method,
        ok: true as const,
        result,
        _meta: { runtimeId: 'runtime_b' }
      })
      if (method === 'status.get') {
        return ok({
          runtimeId: 'runtime_b',
          capabilities: [
            ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
            ...(defaultChoice === 'unsupported' ? [] : [PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY])
          ]
        })
      }
      if (method === 'agent.resolveDefault') {
        if (defaultChoice === 'unavailable') {
          return {
            id: method,
            ok: false,
            error: { code: 'agent_unconfigured', message: 'Codex unavailable' }
          }
        }
        const validation = z.object({ validateAgent: z.string().optional() }).parse(params)
        return ok({
          agent: validation.validateAgent ?? (defaultChoice === 'blank' ? null : defaultChoice),
          source: validation.validateAgent ? 'explicit' : 'project',
          projectId: 'project-b'
        })
      }
      if (method === 'orchestration.peerMailPull') {
        await new Promise((resolve) => setImmediate(resolve))
        return ok({ items: [] })
      }
      if (method === 'orchestration.peerMailAck') {
        return ok({})
      }
      const guard = await send?.prepareGuard?.({
        endpoint: 'ws://127.0.0.1:1',
        hostPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        credential: { kind: 'token', deviceToken: 'test-home-token' }
      })
      guard?.()
      if (method === 'orchestration.workerShow') {
        return ok({
          worker: { startOptions: { agent: 'codex', agentSelection: DEFAULT_SELECTION } }
        })
      }
      if (method === 'orchestration.workerStart') {
        const request = z
          .object({ agent: z.string(), retryOf: z.string().optional() })
          .parse(params)
        return ok({
          dispatchId: request.retryOf ? 'ctx_b2' : 'ctx_b1',
          run: { id: 'run_on_b' },
          state: 'ready',
          agent: request.agent
        })
      }
      throw new Error(`Unexpected remote method: ${method}`)
    }
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-default-selection-'))
    db = new OrchestrationDb(join(directory, 'orchestration.sqlite'))
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    runtime.setOrchestrationDb(db)
    defaultChoice = 'codex'
    vi.spyOn(runtime, 'readMachineName').mockReturnValue('Mac A')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(pane)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockReturnValue(pane)
  })
  afterEach(() => {
    runtime.stopOrchestrationFederationRelay()
    db.close()
    rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  const start = (params: Params, requestId = 'default-start') =>
    startRemoteOwnedWorker(
      runtime,
      params,
      { runtime, orchestrationCompatibilityEvidence: { paneKey: pane } },
      requestId
    )
  const reopen = () => {
    runtime.stopOrchestrationFederationRelay()
    db.close()
    db = new OrchestrationDb(join(directory, 'orchestration.sqlite'))
    runtime.setOrchestrationDb(db)
  }

  it.each([{ adoptTaskId: 'task_remote' }, { resolvedAgentSelection: DEFAULT_SELECTION }])(
    'rejects paired-only start fields from a local caller',
    async (forwarded) => {
      await expect(
        prepareWorkerStart(
          { ...target, agent: 'codex', ...forwarded },
          {
            runtime,
            orchestrationCompatibilityEvidence: { paneKey: pane }
          }
        )
      ).rejects.toMatchObject({ code: 'invalid_argument', data: { effectsApplied: false } })
      expect(db.listRuns().runs.filter((run) => !run.legacy)).toEqual([])
      expect(db.listTasks()).toEqual([])
    }
  )

  it.each(['blank', 'unavailable', 'unsupported'] as const)(
    'refuses %s before binding a Run or reserving a Task',
    async (choice) => {
      defaultChoice = choice
      await expect(start(target)).rejects.toMatchObject({
        code: choice === 'unsupported' ? 'capability_unsupported' : 'agent_unconfigured'
      })
      expect(db.listRuns().runs.filter((run) => !run.legacy)).toEqual([])
      expect(db.listTasks()).toEqual([])
    }
  )

  it('preserves the first agent and source across migration, restart, replay and retry', async () => {
    db.db.exec('ALTER TABLE remote_placements DROP COLUMN agent_selection')
    reopen()
    const first = StartedDefault.parse(await start(target))
    expect(first).toMatchObject({ agent: 'codex', agentSelection: DEFAULT_SELECTION })
    reopen()
    defaultChoice = 'claude'
    expect(StartedDefault.parse(await start(target))).toMatchObject({
      agent: 'codex',
      agentSelection: DEFAULT_SELECTION
    })
    const placement = getRemotePlacement(db, first.taskId)!
    importRemoteOwnedItem(db, remoteServerPin(remote), {
      conversationId: placement.conversation_id,
      sequence: 1,
      messageId: 'failed',
      kind: 'worker_state',
      payload: JSON.stringify({
        v: 1,
        id: 'failed',
        homeRunId: first.runId,
        peerRunId: 'run_on_b',
        dispatch: {
          id: 'ctx_b1',
          taskId: first.taskId,
          status: 'failed',
          workerState: 'failed',
          lastFailure: null,
          agent: 'codex'
        },
        task: { status: 'blocked', result: null },
        correctedUnobservedPrompt: false,
        removed: null
      })
    })
    expect(
      StartedDefault.parse(
        await start(
          { ...target, spec: undefined, task: first.taskId, retryOf: 'ctx_b1' },
          'retry-default'
        )
      )
    ).toMatchObject({
      agent: 'codex',
      agentSelection: DEFAULT_SELECTION
    })
  })
})
