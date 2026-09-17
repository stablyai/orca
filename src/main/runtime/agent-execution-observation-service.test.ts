import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { AgentExecutionObservationService } from './agent-execution-observation-service'
import { buildAgentExecutionAttachments } from './agent-execution-observation-attachments'

describe('AgentExecutionObservationService', () => {
  it('uses the owning SSH controller and exact process incarnation', async () => {
    const controllerBase = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    }
    const sshController = {
      ...controllerBase,
      listProcesses: vi.fn(async () => [
        { id: 'pty-1', incarnationId: 'inc-1', cwd: '/tmp', title: 'agent' }
      ])
    }
    const localController = { ...controllerBase, listProcessesWithHostScope: vi.fn() }
    const published: unknown[] = []
    const service = new AgentExecutionObservationService({
      getController: (hostId) => (hostId.startsWith('ssh:') ? sshController : localController),
      getHostEpoch: () => 'relay-epoch-1',
      getAttachments: () => [
        {
          executionId: 'exec-1',
          hostId: 'ssh:target',
          hostEpoch: 'relay-epoch-1',
          processIncarnation: 'pty-1:inc-1'
        }
      ],
      publish: (observation) => published.push(observation),
      listDeadlineMs: 1_000
    })

    const result = service.observe('exec-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(result).resolves.toMatchObject({
      executionId: 'exec-1',
      hostId: 'ssh:target',
      verdict: 'live',
      inventoryCoverage: 'complete'
    })
    expect(sshController.listProcesses).toHaveBeenCalledWith('target', expect.any(Object))
    expect(localController.listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(published).toHaveLength(1)
    service.stop()
  })

  it('derives exact attachments from committed owner bindings and never guesses host or process', () => {
    const owner: AgentSessionOwnerBinding = {
      claim: {
        digestVersion: 1,
        keyId: 'key',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        agent: 'codex'
      },
      generation: 'generation-1',
      phase: 'live' as const,
      ptyId: 'pty-1',
      surface: {
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_handle'
      },
      statusBinding: {
        runId: 'run-1',
        attachment: { executionId: 'attachment-1' },
        role: 'root' as const,
        continuityOf: 'run-0'
      }
    }
    const ptyOwnership = new Map<string, string | null>([['pty-1', 'ssh-target']])
    const ptyIncarnationById = new Map<string, string>([['pty-1', 'inc-1']])
    expect(
      buildAgentExecutionAttachments([owner], {
        ptyOwnership,
        ptyIncarnationById,
        getHostEpoch: (hostId) => `${hostId}:epoch-1`
      })
    ).toEqual([
      {
        executionId: 'attachment-1',
        runId: 'run-1',
        role: 'root',
        continuityOf: 'run-0',
        hostId: 'ssh:ssh-target',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        hostEpoch: 'ssh:ssh-target:epoch-1',
        processIncarnation: 'pty-1:inc-1',
        processId: 'pty-1',
        processIncarnationId: 'inc-1'
      }
    ])
    expect(
      buildAgentExecutionAttachments([owner], {
        ptyOwnership: new Map(),
        ptyIncarnationById,
        getHostEpoch: () => 'epoch-1'
      })
    ).toEqual([])
    expect(
      buildAgentExecutionAttachments([owner], {
        ptyOwnership,
        ptyIncarnationById: new Map(),
        getHostEpoch: () => 'epoch-1'
      })
    ).toEqual([
      {
        executionId: 'attachment-1',
        runId: 'run-1',
        role: 'root',
        continuityOf: 'run-0',
        hostId: 'ssh:ssh-target',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        hostEpoch: 'epoch-1'
      }
    ])

    const remoteOwner = { ...owner, ptyId: 'ssh:ssh-target@@pty-2' }
    expect(
      buildAgentExecutionAttachments([remoteOwner], {
        ptyOwnership: new Map(),
        ptyIncarnationById: new Map(),
        getHostEpoch: (hostId) => `${hostId}:epoch-2`
      })
    ).toEqual([
      {
        executionId: 'attachment-1',
        runId: 'run-1',
        role: 'root',
        continuityOf: 'run-0',
        hostId: 'ssh:ssh-target',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        hostEpoch: 'ssh:ssh-target:epoch-2'
      }
    ])
  })

  it('does not fall back to a local controller when an SSH controller is unavailable', async () => {
    const localController = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcessesWithHostScope: vi.fn(async () => ({ processes: [], hostIds: ['local'] }))
    }
    const service = new AgentExecutionObservationService({
      getController: () => null,
      getHostEpoch: () => 'epoch-1',
      getAttachments: () => [
        {
          executionId: 'exec-1',
          hostId: 'ssh:target',
          hostEpoch: 'epoch-1',
          processIncarnation: 'pty-1:inc-1'
        }
      ],
      publish: () => undefined
    })

    await expect(service.observe('exec-1')).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(localController.listProcessesWithHostScope).not.toHaveBeenCalled()
    service.stop()
  })

  it('uses host process evidence to distinguish an agent exit from a live PTY shell', async () => {
    const controller: RuntimePtyController = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'bash',
      listProcessesWithHostScope: vi.fn(
        async (): Promise<{
          processes: PtyProcessInfo[]
          hostIds: ExecutionHostId[]
        }> => ({
          processes: [{ id: 'pty-1', incarnationId: 'inc-1', cwd: '/tmp', title: 'shell' }],
          hostIds: ['local' satisfies ExecutionHostId]
        })
      ),
      inspectProcess: vi.fn(async () => ({
        foregroundProcess: 'bash',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children' as const
      }))
    }
    const service = new AgentExecutionObservationService({
      getController: () => controller,
      getHostEpoch: () => 'epoch-1',
      getAttachments: () => [
        {
          executionId: 'exec-1',
          hostId: 'local',
          hostEpoch: 'epoch-1',
          processIncarnation: 'pty-1:inc-1',
          processId: 'pty-1',
          processIncarnationId: 'inc-1'
        }
      ],
      publish: () => undefined
    })

    const result = service.observe('exec-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(result).resolves.toMatchObject({ verdict: 'exited' })
    expect(controller.inspectProcess).toHaveBeenCalledWith('pty-1', {
      expectedIncarnationId: 'inc-1',
      scanChildProcesses: true
    })
    service.stop()
  })

  it('does not overlap a timed-out host inventory while the provider call is still pending', async () => {
    let resolveInventory!: (value: {
      processes: PtyProcessInfo[]
      hostIds: ExecutionHostId[]
    }) => void
    const listProcessesWithHostScope = vi.fn(
      () =>
        new Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }>((resolve) => {
          resolveInventory = resolve
        })
    )
    const controller: RuntimePtyController = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcessesWithHostScope
    }
    const service = new AgentExecutionObservationService({
      getController: () => controller,
      getHostEpoch: () => 'epoch-1',
      getAttachments: () => [
        {
          executionId: 'exec-1',
          hostId: 'local',
          hostEpoch: 'epoch-1',
          processIncarnation: 'pty-1:inc-1'
        }
      ],
      publish: () => undefined,
      listDeadlineMs: 5
    })

    await expect(service.observe('exec-1')).resolves.toMatchObject({ verdict: 'unverifiable' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(service.observe('exec-1')).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(listProcessesWithHostScope).toHaveBeenCalledOnce()
    resolveInventory({ processes: [], hostIds: ['local'] })
    service.stop()
  })

  it('bounds nested process inspection by the host scan deadline', async () => {
    let listCalls = 0
    const controller: RuntimePtyController = {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcessesWithHostScope: vi.fn(async () => {
        listCalls += 1
        return {
          processes: [{ id: 'pty-1', incarnationId: 'inc-1', cwd: '/tmp', title: 'agent' }],
          hostIds: ['local' as const]
        }
      }),
      inspectProcess: vi.fn(() => new Promise<never>(() => {}))
    }
    const service = new AgentExecutionObservationService({
      getController: () => controller,
      getHostEpoch: () => 'epoch-1',
      getAttachments: () => [
        {
          executionId: 'exec-1',
          hostId: 'local',
          hostEpoch: 'epoch-1',
          processIncarnation: 'pty-1:inc-1',
          processId: 'pty-1',
          processIncarnationId: 'inc-1'
        }
      ],
      publish: () => undefined,
      listDeadlineMs: 5
    })

    await expect(service.observe('exec-1')).resolves.toMatchObject({ verdict: 'unverifiable' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(service.observe('exec-1')).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(listCalls).toBe(2)
    service.stop()
  })
})
