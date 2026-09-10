import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptManagedTerminalInput } from './managed-terminal-input-acceptance'
import { TerminalSend } from './unary-schemas'

const resolveMaestroWorkspacePrincipalMock = vi.hoisted(() => vi.fn())

vi.mock('../../maestro-principal', () => ({
  resolveMaestroWorkspacePrincipal: resolveMaestroWorkspacePrincipalMock
}))

const TEXT = 'Continue with the corrected workspace.'
const LEASE = {
  id: 'lease-1',
  executionHostId: 'ssh:host-1',
  workspaceKey: 'worktree:repo-1::/workspace',
  terminalHandle: 'terminal-worker',
  lifecycleState: 'ready'
}

function params(
  generation = 3,
  authority: 'coordinator' | 'worker' | 'user' = 'coordinator',
  observedInputSurface:
    | 'ready_prompt'
    | 'working'
    | 'permission'
    | 'input_required' = 'ready_prompt'
) {
  return TerminalSend.parse({
    terminal: LEASE.terminalHandle,
    text: TEXT,
    leaseInput: {
      commandId: 'command-1',
      idempotencyKey: 'input-1',
      contentDigest: `sha256:${createHash('sha256').update(TEXT).digest('hex')}`,
      enqueueSequence: 1,
      leaseId: LEASE.id,
      authority,
      runId: 'run-1',
      coordinatorGeneration: generation,
      expectedLifecycleState: 'ready',
      observedInputSurface,
      expiresAt: '2099-09-08T00:00:00.000Z',
      expectedGraphRevision: 12
    }
  })
}

function context(
  runGeneration = 3,
  overrides: {
    clientKind?: 'mobile' | 'runtime'
    agentStatus?: 'idle' | 'working' | 'permission'
    agentWait?: object | null
  } = {}
) {
  const acceptMaestroTerminalInput = vi.fn().mockReturnValue({
    replayed: false,
    receipt: { commandId: 'command-1', state: 'accepted' }
  })
  const transitionMaestroTerminalInput = vi.fn(
    (input: { state: string; rejectionCode?: string }) => ({
      commandId: 'command-1',
      state: input.state,
      rejectionCode: input.rejectionCode ?? null,
      bytesWritten: 0
    })
  )
  const runtime = {
    getOrchestrationDb: () => ({
      getMaestroTerminalLeaseByHandle: () => LEASE,
      getRun: () => ({ consumer_generation: runGeneration }),
      acceptMaestroTerminalInput,
      transitionMaestroTerminalInput
    }),
    showTerminal: vi.fn().mockResolvedValue({
      tabId: 'tab-worker',
      agentWait: overrides.agentWait ?? null
    }),
    getTerminalAgentStatus: vi.fn().mockResolvedValue({ status: overrides.agentStatus ?? 'idle' }),
    getTerminalProcessIncarnation: vi.fn().mockReturnValue('pty-worker:incarnation-1')
  }
  return {
    context: { runtime, clientKind: overrides.clientKind } as never,
    acceptMaestroTerminalInput,
    transitionMaestroTerminalInput
  }
}

describe('managed terminal input authority', () => {
  beforeEach(() => {
    resolveMaestroWorkspacePrincipalMock.mockReset()
    resolveMaestroWorkspacePrincipalMock.mockResolvedValue({
      actor_id: 'terminal-coordinator',
      kind: 'coordinator',
      authenticated: true,
      session_id: 'coordinator-session',
      generation: 3,
      workspace: {
        execution_host_id: LEASE.executionHostId,
        workspace_key: LEASE.workspaceKey,
        run_id: 'run-1'
      }
    })
  })

  it('uses the shared Run and workspace principal before accepting input', async () => {
    const fixture = context()

    await expect(acceptManagedTerminalInput(params(), fixture.context)).resolves.toEqual({
      commandId: 'command-1'
    })
    expect(resolveMaestroWorkspacePrincipalMock).toHaveBeenCalledWith(fixture.context, {
      execution_host_id: LEASE.executionHostId,
      workspace_key: LEASE.workspaceKey,
      run_id: 'run-1'
    })
    expect(fixture.acceptMaestroTerminalInput).toHaveBeenCalledOnce()
  })

  it('rejects the wrong actor kind and stale coordinator generation', async () => {
    resolveMaestroWorkspacePrincipalMock.mockResolvedValueOnce({
      kind: 'worker',
      authenticated: true
    })
    const wrongActor = context()
    await expect(acceptManagedTerminalInput(params(), wrongActor.context)).rejects.toThrow(
      'Coordinator terminal input authority is stale.'
    )
    expect(wrongActor.acceptMaestroTerminalInput).not.toHaveBeenCalled()

    resolveMaestroWorkspacePrincipalMock.mockResolvedValueOnce({
      kind: 'coordinator',
      authenticated: true,
      generation: 2
    })
    const staleGeneration = context()
    await expect(acceptManagedTerminalInput(params(), staleGeneration.context)).rejects.toThrow(
      'Coordinator terminal input authority is stale.'
    )
    expect(staleGeneration.acceptMaestroTerminalInput).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied user authority outside an interactive client', async () => {
    const fixture = context()

    await expect(acceptManagedTerminalInput(params(3, 'user'), fixture.context)).rejects.toThrow(
      'User terminal input authority requires an authenticated interactive client.'
    )
    expect(resolveMaestroWorkspacePrincipalMock).not.toHaveBeenCalled()
    expect(fixture.acceptMaestroTerminalInput).not.toHaveBeenCalled()
  })

  it('derives user authority from an authenticated interactive client', async () => {
    const fixture = context(3, { clientKind: 'mobile' })

    await expect(acceptManagedTerminalInput(params(3, 'user'), fixture.context)).resolves.toEqual({
      commandId: 'command-1'
    })
    expect(resolveMaestroWorkspacePrincipalMock).not.toHaveBeenCalled()
    expect(fixture.acceptMaestroTerminalInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: expect.objectContaining({ authority: 'user', principalId: 'mobile' })
      })
    )
  })

  it('preserves envelope-free input from authenticated interactive clients only', async () => {
    const interactive = context(3, { clientKind: 'runtime' })
    const withoutEnvelope = TerminalSend.parse({ terminal: LEASE.terminalHandle, text: TEXT })

    await expect(acceptManagedTerminalInput(withoutEnvelope, interactive.context)).resolves.toEqual(
      { commandId: null }
    )
    await expect(acceptManagedTerminalInput(withoutEnvelope, context().context)).rejects.toThrow(
      'Agent input to an orchestration-owned terminal requires a lease input envelope.'
    )
  })

  it('returns explicit nondelivery when the observed surface is not ready', async () => {
    const fixture = context(3, { agentStatus: 'working' })

    await expect(
      acceptManagedTerminalInput(params(3, 'coordinator', 'working'), fixture.context)
    ).resolves.toEqual({
      send: {
        handle: LEASE.terminalHandle,
        accepted: false,
        bytesWritten: 0,
        deliveryReceipt: expect.objectContaining({
          state: 'rejected',
          rejectionCode: 'input_surface_not_ready'
        })
      }
    })
    expect(fixture.transitionMaestroTerminalInput).toHaveBeenCalledWith({
      commandId: 'command-1',
      state: 'rejected',
      rejectionCode: 'input_surface_not_ready'
    })
  })
})
