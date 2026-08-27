import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { ControlPlaneStore } from '../orchestration/control-plane/control-plane-store'
import {
  acquireValidationLease,
  releaseValidationLease
} from '../orchestration/control-plane/validation-lease'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { FILE_METHODS } from './methods/files'
import { GIT_METHODS } from './methods/git'
import { LEASE_FENCED_METHODS } from './validation-lease-fence'

/** MUTATION_UNDER_A_RUNNING_GATE — the validation lease had exactly one
 *  consumer, so every ordinary mutation RPC could edit a worktree while its
 *  gate was still running and the resulting receipt still counted.
 */
describe('MUTATION_UNDER_A_RUNNING_GATE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const commit = vi.fn().mockResolvedValue({ ok: true })
  const write = vi.fn().mockResolvedValue({ ok: true })

  function world(lease: boolean) {
    db = new OrchestrationDb(':memory:')
    if (lease) {
      const acquired = acquireValidationLease(new ControlPlaneStore(db), {
        scopeKey: 'wt:wt-1',
        leaseId: 'lease_1',
        owner: 'dispatch_gate',
        idempotencyKey: 'idem',
        nowMs: Date.now()
      })
      expect(acquired.ok).toBe(true)
    }
    commit.mockClear()
    write.mockClear()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getOrchestrationDb: () => db,
      showManagedTerminalWorkspace: async (selector: string) => ({ id: selector.slice(3) }),
      commitRuntimeGit: commit,
      writeFileExplorerFile: write
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: [...GIT_METHODS, ...FILE_METHODS] })
  }

  const request = (method: string, params: unknown) => ({
    id: 'req-1',
    authToken: 'tok',
    method,
    params
  })

  it('refuses a commit into a worktree under a live validation lease', async () => {
    const dispatcher = world(true)
    const response = await dispatcher.dispatch(
      request('git.commit', { worktree: 'id:wt-1', message: 'sneak it in' })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'validation_in_progress' } })
    // The point of the fence: the handler never ran, so nothing was mutated.
    expect(commit).not.toHaveBeenCalled()
  })

  it('refuses a file write the same way, from the same one fence', async () => {
    const dispatcher = world(true)
    const response = await dispatcher.dispatch(
      request('files.write', { worktree: 'id:wt-1', relativePath: 'a.ts', content: 'x' })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'validation_in_progress' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('lets an unleased worktree through untouched', async () => {
    const dispatcher = world(true)
    await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-2', message: 'fine' }))
    expect(commit).toHaveBeenCalledWith('id:wt-2', 'fine')
  })

  it('negative control: the same commit succeeds once the lease is released', async () => {
    const dispatcher = world(true)
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'blocked' }))
    ).toMatchObject({ ok: false })
    releaseValidationLease(new ControlPlaneStore(db!), {
      scopeKey: 'wt:wt-1',
      leaseId: 'lease_1',
      owner: 'dispatch_gate',
      nowMs: Date.now()
    })
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'allowed' }))
    ).toMatchObject({ ok: true })
    expect(commit).toHaveBeenCalledWith('id:wt-1', 'allowed')
  })

  it('is inert when no lease exists at all', async () => {
    const dispatcher = world(false)
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'ok' }))
    ).toMatchObject({ ok: true })
  })

  it('fences every mutating git and files method, and no read', () => {
    const mutating = ['git.commit', 'git.push', 'files.write', 'files.delete', 'terminal.send']
    const reads = ['git.status', 'files.list', 'files.open', 'terminal.wait']
    expect(mutating.filter((method) => LEASE_FENCED_METHODS.has(method))).toEqual(mutating)
    expect(reads.filter((method) => LEASE_FENCED_METHODS.has(method))).toEqual([])
  })
})
