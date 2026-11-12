import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from '../../../../orchestration/legacy-remote/federation'
import type { TerminalWorkspaceLaunchScope } from '../../../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const folder: TerminalWorkspaceLaunchScope = {
  id: 'folder:worker',
  path: '/workspace/worker',
  connectionId: null,
  repo: null,
  folderWorkspace: {
    id: 'worker',
    projectGroupId: 'group',
    name: 'Worker',
    folderPath: '/workspace/worker',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

const mutation = {
  callerFingerprint: 'home_peer',
  requestId: 'request_admission',
  method: 'orchestration.federationAttachStart',
  payloadHash: 'admission_payload'
}

function attach(runtime: OrcaRuntimeService, placement: Record<string, unknown> = {}) {
  const method = ORCHESTRATION_FEDERATION_ATTACH_METHODS[0]
  return method.handler(
    method.params!.parse({
      dispatchId: 'ctx_admission',
      taskId: 'task_admission',
      taskSpec: 'Work in the exact workspace',
      protocolVersion: 3,
      worktree: 'folder:worker',
      agent: 'codex',
      ...placement
    }),
    { runtime, orchestrationMutation: mutation }
  )
}

describe('federated execution-host admission', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function workerHost() {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederationWorkerRuntime(runtime)
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue(folder)
    return { runtime, db }
  }

  it.each(['folder:worker', 'new-top-level'])(
    'refuses an unavailable launcher before attachment and resource creation for %s',
    async (worktree) => {
      const { runtime, db } = workerHost()
      const refusal = new OrchestrationError('agent_not_available', 'Codex is not installed.')
      vi.mocked(runtime.validateOrchestrationAgentLauncherForWorktree).mockRejectedValue(refusal)
      vi.mocked(runtime.validateOrchestrationAgentLauncherForRepo).mockRejectedValue(refusal)
      const createTerminal = vi.spyOn(runtime, 'createTerminal')

      await expect(
        attach(runtime, {
          worktree,
          ...(worktree === 'new-top-level' ? { repo: 'id:windows-repo' } : {})
        })
      ).rejects.toBe(refusal)

      expect(db.getRemoteDispatchAttachment('ctx_admission')).toBeUndefined()
      expect(db.getMutationReceipt('home_peer', 'request_admission')).toBeUndefined()
      expect(createTerminal).not.toHaveBeenCalled()
      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    }
  )

  it('keeps missing-workspace classification ahead of launcher admission', async () => {
    const { runtime, db } = workerHost()
    vi.mocked(runtime.showTerminalWorkspaceLaunchScope).mockRejectedValue(
      new Error('selector_not_found')
    )

    await expect(attach(runtime)).rejects.toMatchObject({ code: 'worktree_not_found_on_server' })
    expect(runtime.validateOrchestrationAgentLauncherForWorktree).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment('ctx_admission')).toBeUndefined()
  })

  it.each(['remote_runtime_unavailable', 'ssh_host_not_served'])(
    'does not disguise %s from workspace resolution or admission as a missing workspace',
    async (code) => {
      const { runtime, db } = workerHost()
      const refusal = new OrchestrationError(code, 'The execution host cannot be probed.')
      vi.mocked(runtime.showTerminalWorkspaceLaunchScope).mockRejectedValueOnce(refusal)
      await expect(attach(runtime)).rejects.toBe(refusal)
      vi.mocked(runtime.validateOrchestrationAgentLauncherForWorktree).mockRejectedValue(refusal)
      await expect(attach(runtime)).rejects.toBe(refusal)
      expect(db.getRemoteDispatchAttachment('ctx_admission')).toBeUndefined()
      expect(db.getMutationReceipt('home_peer', 'request_admission')).toBeUndefined()
    }
  )

  it('starts in an existing folder without inventing a repository selector', async () => {
    const { runtime, db } = workerHost()
    vi.mocked(runtime.showRepo).mockRejectedValue(new Error('A folder has no repository.'))
    const terminal = await runtime.showTerminal('term_windows_worker')
    vi.mocked(runtime.showTerminal).mockResolvedValue({ ...terminal, worktreeId: 'folder:worker' })
    const create = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'folder:worker',
      title: 'Codex'
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    vi.spyOn(runtime, 'subscribeToTerminalData').mockReturnValue(() => {})

    const result = await attach(runtime)

    expect(result).toMatchObject({ state: 'ready', worktreeId: 'folder:worker' })
    expect(db.getRemoteDispatchAttachment('ctx_admission')).toMatchObject({ state: 'ready' })
    expect(runtime.validateOrchestrationAgentLauncherForWorktree).toHaveBeenCalledWith(
      'codex',
      'folder:worker',
      'terminal'
    )
    expect(runtime.validateOrchestrationAgentLauncherForRepo).not.toHaveBeenCalled()
    expect(runtime.showRepo).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith('id:folder:worker', expect.any(Object))
  })
})
