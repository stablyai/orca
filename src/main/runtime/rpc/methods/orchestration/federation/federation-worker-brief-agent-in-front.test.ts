import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { LaunchedAgentForeground } from '../../../../launched-agent-foreground'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const PTY_ID = 'pty_worker'

// Why: a shell back at its prompt after the agent exits reads as ready too, so the worker host
// must find the launched agent in front before it types the brief, or the shell runs the brief.
describe('a paired-server worker start writes its brief only into the agent it launched', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function workerHost(foreground: LaunchedAgentForeground, provesAgent = true) {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederationWorkerRuntime(runtime)
    const writes: string[] = []
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
    vi.spyOn(runtime, 'launchedAgentHostProvesAgent').mockReturnValue(provesAgent)
    vi.spyOn(runtime, 'subscribeToTerminalData').mockReturnValue(() => {})
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementation(async (handle, text, options) => {
      await options?.beforeWrite?.(PTY_ID)
      writes.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    })
    return { runtime, writes }
  }

  async function attach(runtime: OrcaRuntimeService): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }
    return await method.handler(
      method.params!.parse({
        runId: 'run-home',
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote worker',
        protocolVersion: 3,
        worktree: 'new-top-level',
        repo: 'windows-repo',
        name: 'remote-worker',
        agent: 'claude'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )
  }

  it('types nothing when the agent exited and its shell is in front', async () => {
    const host = workerHost('shell')

    await expect(attach(host.runtime)).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'dispatch_input',
      lastError: 'agent_not_in_foreground'
    })
    expect(host.writes).toEqual([])
  })

  it('types nothing where the host cannot tell what is in front', async () => {
    const host = workerHost('unknown')

    await expect(attach(host.runtime)).resolves.toMatchObject({ state: 'failed' })
    expect(host.writes).toEqual([])
  })

  it('writes the brief once into the agent found in front', async () => {
    const host = workerHost('agent')

    await expect(attach(host.runtime)).resolves.toMatchObject({ state: 'ready' })
    expect(host.writes).toHaveLength(1)
  })

  it('on a host that cannot prove the agent (Windows), writes unless a shell is proven', async () => {
    const unknown = workerHost('unknown', false)
    await expect(attach(unknown.runtime)).resolves.toMatchObject({ state: 'ready' })
    expect(unknown.writes).toHaveLength(1)

    const shell = workerHost('shell', false)
    await expect(attach(shell.runtime)).resolves.toMatchObject({ state: 'failed' })
    expect(shell.writes).toEqual([])
  })
})
