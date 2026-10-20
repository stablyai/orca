import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { RepositoryAddScriptExecutionResult } from '../../shared/repository-add-script-types'
import {
  RepositoryAddScriptService,
  type RepositoryAddScriptRun
} from './repository-add-script-service'

function setup() {
  const repos = new Map<string, Repo>()
  const runScript = vi.fn(
    async (
      _run: RepositoryAddScriptRun,
      _isAuthorized: () => boolean,
      _signal: AbortSignal
    ): Promise<RepositoryAddScriptExecutionResult> => ({ exitCode: 0, output: '' })
  )
  const service = new RepositoryAddScriptService({
    getOwner: (hostId) => ({ hostId, label: 'Local', available: true, supported: true }),
    getRepo: (id) => repos.get(id),
    repoExists: (id) => repos.has(id),
    getScript: () => 'echo configured',
    resolveTarget: (repo) => ({ kind: 'native', cwd: repo.path }),
    runScript
  })
  function offer(id: string) {
    const repo: Repo = { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1 }
    repos.set(id, repo)
    const preview = service.offerForRegistration({ repo, disposition: 'new' })
    if (!preview) {
      throw new Error('Expected preview')
    }
    return preview
  }
  return { service, repos, runScript, offer }
}

function run(preview: { token: string; hostId: ExecutionHostId; repoId: string }) {
  const { token, hostId, repoId } = preview
  return { token, hostId, repoId, decision: 'run' as const }
}

// Resolves when the runner sees its abort signal fire.
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

describe('RepositoryAddScriptService.close', () => {
  it('closes synchronously: revokes pending previews and refuses new offers and decisions', async () => {
    const state = setup()
    const pending = state.offer('a')
    void state.service.close()
    expect(state.service.getOutcome(pending)).toEqual({ status: 'revoked' })
    expect(await state.service.decide(run(pending))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    const repo: Repo = { id: 'b', path: '/b', displayName: 'b', badgeColor: '', addedAt: 1 }
    state.repos.set(repo.id, repo)
    expect(state.service.offerForRegistration({ repo, disposition: 'new' })).toBeNull()
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it('aborts active runs at the call, keeps their records, and settles every close after them', async () => {
    const state = setup()
    let finish = (_result: RepositoryAddScriptExecutionResult): void => {}
    let seenSignal: AbortSignal | undefined
    state.runScript.mockImplementation(async (_run, _check, signal) => {
      seenSignal = signal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const preview = state.offer('a')
    const decision = state.service.decide(run(preview))
    expect(seenSignal?.aborted).toBe(false)
    let closed = 0
    const first = state.service.close().then(() => closed++)
    expect(seenSignal?.aborted).toBe(true)
    const second = state.service.close().then(() => closed++)
    expect(state.service.getOutcome(preview)).toEqual({ status: 'running' })
    await Promise.resolve()
    expect(closed).toBe(0)
    finish({ exitCode: 0, output: 'stopped' })
    await Promise.all([first, second])
    expect(closed).toBe(2)
    // An aborted run never counts as a success, even when the process reports 0.
    const result = await decision
    expect(result).toMatchObject({ status: 'failed', output: 'stopped' })
    expect('exitCode' in result).toBe(false)
  })

  it('denies the pre-spawn check after close and reports stale rather than a failure', async () => {
    const state = setup()
    state.runScript.mockImplementation(async (_run, check, signal) => {
      await untilAborted(signal)
      if (!check()) {
        throw new Error('blocked before spawn')
      }
      return { exitCode: 0, output: '' }
    })
    const preview = state.offer('a')
    const decision = state.service.decide(run(preview))
    await state.service.close()
    expect(await decision).toEqual({ status: 'stale' })
  })

  it('reports a pre-start abort that throws without consulting the check as stale', async () => {
    const state = setup()
    state.runScript.mockImplementation(async (_run, _check, signal) => {
      await untilAborted(signal)
      throw new Error('aborted before start')
    })
    const preview = state.offer('a')
    const decision = state.service.decide(run(preview))
    void state.service.close()
    expect(await decision).toEqual({ status: 'stale' })
  })

  it('keeps an unverifiable stop as unverifiable, retaining the intent and the registration', async () => {
    const state = setup()
    state.runScript.mockImplementation(async (_run, _check, signal) => {
      await untilAborted(signal)
      return { processVerdict: 'unverifiable', exitCode: 0, output: 'may still be running' }
    })
    const preview = state.offer('a')
    const decision = state.service.decide(run(preview))
    await state.service.close()
    expect(await decision).toEqual({
      status: 'unverifiable',
      output: 'may still be running',
      outputTruncated: false
    })
    expect(state.service.getOutcome(preview)?.status).toBe('unverifiable')
    expect(
      state.service.offerForRegistration({ repo: state.repos.get('a')!, disposition: 'new' })
    ).toBeNull()
    // The close promise fulfilled, but the service still reports the run as not proven gone.
    expect(state.service.hasUnsettledRuns()).toBe(true)
  })

  it('reports no unsettled runs once every run settled or none started', async () => {
    const state = setup()
    expect(state.service.hasUnsettledRuns()).toBe(false)
    let finish = (_result: RepositoryAddScriptExecutionResult): void => {}
    state.runScript.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const decision = state.service.decide(run(state.offer('a')))
    expect(state.service.hasUnsettledRuns()).toBe(true)
    finish({ exitCode: 1, output: '' })
    await decision
    expect(state.service.hasUnsettledRuns()).toBe(false)
  })

  it('still reports an ordinary success when nothing was closed', async () => {
    const state = setup()
    const preview = state.offer('a')
    expect(await state.service.decide(run(preview))).toMatchObject({
      status: 'succeeded',
      exitCode: 0
    })
    await state.service.close()
    expect(state.service.getOutcome(preview)).toMatchObject({ status: 'succeeded' })
  })
})
