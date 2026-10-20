import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { prepareDshModelStartupInputs } from '../../../../../dsh/dsh-model-startup-plan'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-startup-plan-inputs'
import { prepareFederationWorkerLaunchOnHost } from './worker-opencode-model-preflight'
import { FederationAttachStartParams } from '../federation/federation-start-schema'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

const h = createOrchestrationRpcHarness()
const paths: string[] = []
afterEach(() => {
  h.cleanup()
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('DSH worker launch preflight', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a real old CLI help response before Dispatch, process creation, or task injection',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-dsh-old-cli-'))
      paths.push(root)
      const executable = join(root, 'dsh-tui')
      writeFileSync(executable, '#!/bin/sh\nprintf "Usage: dsh-tui [prompt]\\n"\n')
      chmodSync(executable, 0o755)
      const { runtime, db, ctx } = h.setup()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only the coordinator workspace id from this terminal snapshot.
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'repo::folder' } as never)
      const createTerminal = vi.spyOn(runtime, 'createTerminal')
      const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
      const inject = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
      vi.spyOn(runtime, 'assertOrchestrationDshModelLaunchSupport').mockImplementation(
        async (target) => {
          await prepareDshModelStartupInputs({
            inputs: resolveAgentStartupPlanInputs({
              agent: 'dsh',
              settings: { agentCmdOverrides: { dsh: executable } },
              platform: process.platform,
              shell: undefined,
              isRemote: false,
              sessionOptions: { model: target.model, effort: target.effort ?? 'high' }
            }),
            cwd: root
          })
        }
      )
      const task = db.createTask({ spec: 'This business task must never reach the old CLI.' })
      await expect(
        h.call(
          'orchestration.workerStart',
          {
            task: task.id,
            from: 'term_coord',
            agent: 'dsh',
            model: 'ark/kimi3',
            effort: 'high'
          },
          ctx
        )
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(db.getDispatchContext(task.id)).toBeUndefined()
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(createTerminal).not.toHaveBeenCalled()
      expect(createWorktree).not.toHaveBeenCalled()
      expect(inject).not.toHaveBeenCalled()
    }
  )

  it.each(['new-child', 'new-top-level'])(
    'checks the requested repository before creating a %s worker',
    async (worktree) => {
      const { runtime, db, ctx } = h.setup()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only worktreeId is read for caller placement.
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'repo::parent' } as never)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only repoId is read before the capability refusal.
      vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ repoId: 'caller-repo' } as never)
      const preflight = vi
        .spyOn(runtime, 'assertOrchestrationDshModelLaunchSupport')
        .mockRejectedValue(new OrchestrationError('capability_unsupported', 'old DSH'))
      const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
      const task = db.createTask({ spec: 'No worktree should be created.' })
      await expect(
        h.call(
          'orchestration.workerStart',
          {
            task: task.id,
            from: 'term_coord',
            agent: 'dsh',
            model: 'ark/kimi3',
            worktree,
            repo: 'exact-worker-repo',
            name: 'dsh-worker'
          },
          ctx
        )
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(preflight).toHaveBeenCalledWith({ repo: 'exact-worker-repo', model: 'ark/kimi3' })
      expect(createWorktree).not.toHaveBeenCalled()
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    }
  )

  it('checks the federated execution host before accepting launch preferences', async () => {
    const { runtime } = h.setup()
    const preflight = vi
      .spyOn(runtime, 'assertOrchestrationDshModelLaunchSupport')
      .mockRejectedValue(new OrchestrationError('capability_unsupported', 'old remote DSH'))
    const params = FederationAttachStartParams.parse({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      taskSpec: 'No remote process',
      protocolVersion: 3,
      worktree: 'new-top-level',
      repo: 'remote-repo',
      name: 'remote-dsh',
      agent: 'dsh',
      model: 'ark/kimi3',
      effort: 'high'
    })
    await expect(
      prepareFederationWorkerLaunchOnHost({ runtime, params, createsWorktree: true })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(preflight).toHaveBeenCalledWith({
      repo: 'remote-repo',
      model: 'ark/kimi3',
      effort: 'high'
    })
  })
})
