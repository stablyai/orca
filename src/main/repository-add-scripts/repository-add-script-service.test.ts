import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { UNRESOLVED_OWNER_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type {
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptPreview,
  RepositoryAddScriptTarget
} from '../../shared/repository-add-script-types'
import {
  RepositoryAddScriptService,
  type RepositoryAddScriptRun
} from './repository-add-script-service'

function setup(hostId: ExecutionHostId = 'local') {
  let repo: Repo | undefined = {
    id: 'repo-1',
    path: '/catalog/repo',
    displayName: 'repo',
    badgeColor: '',
    addedAt: 1,
    executionHostId: hostId
  }
  let script = 'echo configured'
  let available = true
  let supported = true
  const runScript = vi.fn(
    async (
      _run: RepositoryAddScriptRun,
      _isAuthorized: () => boolean,
      _signal: AbortSignal
    ): Promise<RepositoryAddScriptExecutionResult> => ({ exitCode: 0, output: 'done' })
  )
  const service = new RepositoryAddScriptService({
    getOwner: () => ({ hostId, label: 'Owner host', available, supported }),
    getRepo: (id) => (repo?.id === id ? repo : undefined),
    repoExists: (id) => repo?.id === id,
    getScript: () => script,
    resolveTarget: nativeTarget,
    runScript
  })
  function offer(
    disposition: 'new' | 'existing' | 'linked-worktree' | 'folder-conversion' = 'new'
  ) {
    if (!repo) {
      throw new Error('Missing test repo')
    }
    return service.offerForRegistration({ repo, disposition })
  }
  function preview() {
    const value = offer()
    if (!value) {
      throw new Error('Expected preview')
    }
    return value
  }
  return {
    service,
    runScript,
    offer,
    preview,
    setScript: (value: string) => {
      script = value
    },
    setAvailable: (value: boolean) => {
      available = value
    },
    setSupported: (value: boolean) => {
      supported = value
    },
    setRepo: (value: Repo | undefined) => {
      repo = value
    },
    getRepo: () => repo
  }
}

function nativeTarget(repo: Repo): RepositoryAddScriptTarget {
  return { kind: 'native', cwd: repo.path }
}

function request(
  preview: { token: string; hostId: ExecutionHostId; repoId: string },
  decision: 'run' | 'skip' = 'run'
) {
  return { token: preview.token, hostId: preview.hostId, repoId: preview.repoId, decision }
}

describe('RepositoryAddScriptService', () => {
  it('only offers for a successful new Git registration with a configured script', () => {
    const state = setup()
    for (const disposition of ['existing', 'linked-worktree', 'folder-conversion'] as const) {
      expect(state.offer(disposition)).toBeNull()
    }
    state.setRepo({ ...state.getRepo()!, kind: 'folder' })
    expect(state.offer()).toBeNull()
    state.setRepo({ ...state.getRepo()!, kind: 'git' })
    state.setScript(' \n ')
    expect(state.offer()).toBeNull()
    state.setScript('echo configured')
    expect(state.preview()).toMatchObject({
      repoId: 'repo-1',
      path: '/catalog/repo',
      hostId: 'local',
      hostLabel: 'Owner host',
      script: 'echo configured'
    })
    expect(state.preview().scriptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it.each(['ssh:target', 'runtime:host'] as const)(
    'binds approval and execution to %s',
    async (hostId) => {
      const state = setup(hostId)
      const preview = state.preview()
      expect(preview.hostId).toBe(hostId)
      expect(await state.service.decide({ ...request(preview), hostId: 'local' })).toEqual({
        status: 'rejected',
        reason: 'identity-mismatch'
      })
      expect(await state.service.decide(request(preview))).toMatchObject({
        status: 'succeeded',
        output: 'done',
        exitCode: 0
      })
      expect(state.runScript).toHaveBeenCalledWith(
        {
          hostId,
          repoId: 'repo-1',
          path: '/catalog/repo',
          target: { kind: 'native', cwd: '/catalog/repo' },
          script: 'echo configured'
        },
        expect.any(Function),
        expect.any(AbortSignal)
      )
    }
  )

  it('does not offer for unavailable, unsupported or foreign owners', () => {
    const state = setup()
    state.setAvailable(false)
    expect(state.offer()).toBeNull()
    state.setAvailable(true)
    state.setSupported(false)
    expect(state.offer()).toBeNull()
    state.setSupported(true)
    state.setRepo({ ...state.getRepo()!, executionHostId: 'ssh:other' })
    expect(state.offer()).toBeNull()
    expect(setup(UNRESOLVED_OWNER_HOST_ID).offer()).toBeNull()
  })

  it.each(['script', 'path', 'removed', 'host', 'unavailable', 'unsupported', 'folder'] as const)(
    'invalidates approval when %s changes',
    async (change) => {
      const state = setup()
      const preview = state.preview()
      const repo = state.getRepo()!
      if (change === 'script') {
        state.setScript('echo changed')
      }
      if (change === 'path') {
        state.setRepo({ ...repo, path: '/other' })
      }
      if (change === 'removed') {
        state.setRepo(undefined)
      }
      if (change === 'host') {
        state.setRepo({ ...repo, executionHostId: 'ssh:other' })
      }
      if (change === 'unavailable') {
        state.setAvailable(false)
      }
      if (change === 'unsupported') {
        state.setSupported(false)
      }
      if (change === 'folder') {
        state.setRepo({ ...repo, kind: 'folder' })
      }
      expect(await state.service.decide(request(preview))).toEqual({ status: 'stale' })
      expect(await state.service.decide(request(preview))).toEqual({
        status: 'rejected',
        reason: 'used-token'
      })
      expect(state.runScript).not.toHaveBeenCalled()
    }
  )

  it('rejects wrong tokens, wrong repo identities and missing explicit decisions', async () => {
    const state = setup()
    const preview = state.preview()
    expect(await state.service.decide({ ...request(preview), token: 'wrong' })).toEqual({
      status: 'rejected',
      reason: 'invalid-token'
    })
    expect(await state.service.decide({ ...request(preview), repoId: 'other' })).toEqual({
      status: 'rejected',
      reason: 'identity-mismatch'
    })
    // @ts-expect-error Missing decisions must also fail closed at runtime.
    expect(await state.service.decide({ ...request(preview), decision: undefined })).toEqual({
      status: 'rejected',
      reason: 'invalid-decision'
    })
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it('closes skipped and dismissed previews without running or replaying', async () => {
    const state = setup()
    const preview = state.preview()
    expect(await state.service.decide(request(preview, 'skip'))).toEqual({ status: 'skipped' })
    expect(await state.service.decide(request(preview))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    const dismissed = setup()
    const dismissal = dismissed.preview()
    dismissed.service.revoke(dismissal.token)
    expect(dismissed.service.getOutcome(dismissal)).toEqual({ status: 'revoked' })
    expect(await dismissed.service.decide(request(dismissal))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    expect(state.runScript).not.toHaveBeenCalled()
    expect(dismissed.runScript).not.toHaveBeenCalled()
  })

  it('claims synchronously before invoking the asynchronous runner', async () => {
    const state = setup()
    const preview = state.preview()
    let complete = () => {}
    state.runScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ exitCode: 0, output: 'finished' })
        })
    )
    const first = state.service.decide(request(preview))
    expect(state.service.getOutcome(preview)).toEqual({ status: 'running' })
    expect(await state.service.decide(request(preview))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    expect(await state.service.decide(request(preview, 'skip'))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    complete()
    expect(await first).toMatchObject({ status: 'succeeded', output: 'finished' })
    expect(state.runScript).toHaveBeenCalledTimes(1)
  })

  it('retains bounded successful output without allowing mutation or replay after restart', async () => {
    const state = setup()
    const preview = state.preview()
    state.runScript.mockResolvedValue({ exitCode: 0, output: 'x'.repeat(100_000) })
    const result = await state.service.decide(request(preview))
    expect(result).toMatchObject({ status: 'succeeded', outputTruncated: true })
    if (result.status !== 'succeeded') {
      throw new Error('Expected success')
    }
    expect(result.output.length).toBeLessThanOrEqual(16_384)
    result.output = 'mutated'
    expect(state.service.getOutcome(preview)).not.toMatchObject({ output: 'mutated' })
    expect(await setup().service.decide(request(preview))).toEqual({
      status: 'rejected',
      reason: 'invalid-token'
    })
  })

  it('does not let callers mutate the stored approval preview', async () => {
    const state = setup()
    const preview = state.preview()
    preview.script = 'echo forged'
    preview.path = '/forged'
    await state.service.decide(request(preview))
    expect(state.runScript).toHaveBeenCalledWith(
      expect.objectContaining({ script: 'echo configured', path: '/catalog/repo' }),
      expect.any(Function),
      expect.any(AbortSignal)
    )
  })

  it('fails closed when preflight dependencies throw', async () => {
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 1
    }
    const getScript = vi.fn(() => 'echo configured')
    const runScript = vi.fn()
    const service = new RepositoryAddScriptService({
      getOwner: () => ({ hostId: 'local', label: 'Local', available: true, supported: true }),
      getRepo: () => repo,
      repoExists: () => true,
      getScript,
      resolveTarget: nativeTarget,
      runScript
    })
    const preview = service.offerForRegistration({ repo, disposition: 'new' })
    if (!preview) {
      throw new Error('Expected preview')
    }
    getScript.mockImplementation(() => {
      throw new Error('secret')
    })
    expect(await service.decide(request(preview))).toEqual({ status: 'stale' })
    expect(
      service.offerForRegistration({ repo: { ...repo, id: 'another' }, disposition: 'new' })
    ).toBeNull()
    expect(runScript).not.toHaveBeenCalled()
  })

  it('contains thrown runner failures without serializing untrusted errors', async () => {
    const state = setup()
    const preview = state.preview()
    const toString = vi.fn(() => {
      throw new Error('secret')
    })
    state.runScript.mockRejectedValue({ toString, toJSON: toString })
    expect(await state.service.decide(request(preview))).toEqual({
      status: 'failed',
      reason: 'execution-failed'
    })
    expect(state.service.getOutcome(preview)).toEqual({
      status: 'failed',
      reason: 'execution-failed'
    })
    expect(toString).not.toHaveBeenCalled()
    expect(state.getRepo()).toBeDefined()
    expect(await state.service.decide(request(preview))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
  })

  it('lets skip win a concurrent run without invoking the runner', async () => {
    const state = setup()
    const preview = state.preview()
    const skipped = state.service.decide(request(preview, 'skip'))
    const run = state.service.decide(request(preview))
    expect(await skipped).toEqual({ status: 'skipped' })
    expect(await run).toEqual({ status: 'rejected', reason: 'used-token' })
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it('returns the same one-use intent for a repeated coordinator offer', async () => {
    const state = setup()
    const preview = state.preview()
    expect(state.preview()).toEqual(preview)
    await state.service.decide(request(preview, 'skip'))
    expect(state.offer()).toBeNull()
    state.setRepo({ ...state.getRepo()!, id: 'readded-repo' })
    expect(state.preview().token).not.toBe(preview.token)
  })

  it('bounds retained intents and safely forgets old tokens', async () => {
    const state = setup()
    const first = state.preview()
    await state.service.decide(request(first, 'skip'))
    for (let index = 0; index < 140; index++) {
      state.setRepo({ ...state.getRepo()!, id: `repo-${index + 2}` })
      const preview = state.preview()
      await state.service.decide(request(preview, 'skip'))
    }
    expect(state.service.getOutcome(first)).toBeNull()
    expect(await state.service.decide(request(first))).toEqual({
      status: 'rejected',
      reason: 'invalid-token'
    })
  })

  it('never evicts running claims when retention capacity is exhausted', async () => {
    const state = setup()
    const completions: (() => void)[] = []
    state.runScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve({ exitCode: 0, output: 'done' }))
        })
    )
    const first = state.preview()
    const runs = [state.service.decide(request(first))]
    for (let index = 0; index < 127; index++) {
      state.setRepo({ ...state.getRepo()!, id: `running-${index}` })
      runs.push(state.service.decide(request(state.preview())))
    }
    state.setRepo({ ...state.getRepo()!, id: 'over-capacity' })
    expect(state.offer()).toBeNull()
    expect(state.service.getOutcome(first)).toEqual({ status: 'running' })
    expect(await state.service.decide(request(first))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
    expect(state.runScript).toHaveBeenCalledTimes(128)
    for (const complete of completions) {
      complete()
    }
    await Promise.all(runs)
  })

  it('reports nonzero exit status as a retained execution failure', async () => {
    const state = setup()
    const preview = state.preview()
    state.runScript.mockResolvedValue({ exitCode: 7, output: 'failure output' })
    expect(await state.service.decide(request(preview))).toMatchObject({
      status: 'failed',
      exitCode: 7,
      output: 'failure output'
    })
  })

  it('never re-offers a consumed registration after its intent is evicted', async () => {
    const state = setup()
    const original = state.getRepo()!
    const first = state.preview()
    await state.service.decide(request(first))
    for (let index = 0; index < 140; index++) {
      state.setRepo({ ...original, id: `later-${index}` })
      await state.service.decide(request(state.preview(), 'skip'))
    }
    expect(state.service.getOutcome(first)).toBeNull()
    // The original repo is still active in the catalog.
    state.setRepo(original)
    expect(state.offer()).toBeNull()
    expect(state.runScript).toHaveBeenCalledTimes(1)
    state.setRepo({ ...original, id: 'fresh-uuid' })
    expect(state.offer()).not.toBeNull()
  })

  it('refuses new previews rather than forgetting active registrations at the cap', async () => {
    const repos = new Map<string, Repo>()
    const service = new RepositoryAddScriptService({
      getOwner: () => ({ hostId: 'local', label: 'Local', available: true, supported: true }),
      getRepo: (id) => repos.get(id),
      repoExists: (id) => repos.has(id),
      getScript: () => 'echo configured',
      resolveTarget: nativeTarget,
      runScript: vi.fn(async () => ({ exitCode: 0, output: '' }))
    })
    const make = (id: string): Repo => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 1
    })
    let accepted = 0
    for (let index = 0; index < 4096; index++) {
      const repo = make(`r-${index}`)
      repos.set(repo.id, repo)
      const preview = service.offerForRegistration({ repo, disposition: 'new' })
      if (preview) {
        accepted++
        service.revoke(preview.token)
      }
    }
    expect(accepted).toBe(4096)
    const extra = make('extra')
    repos.set(extra.id, extra)
    expect(service.offerForRegistration({ repo: extra, disposition: 'new' })).toBeNull()
    repos.delete('r-0')
    expect(service.offerForRegistration({ repo: extra, disposition: 'new' })).not.toBeNull()
  })

  it('revalidates a repeated pending offer and marks it stale instead of regenerating', () => {
    const state = setup()
    const preview = state.preview()
    state.setScript('echo changed')
    expect(state.offer()).toBeNull()
    expect(state.service.getOutcome(preview)).toEqual({ status: 'stale' })
    state.setScript('echo configured')
    expect(state.offer()).toBeNull()
  })

  it('hands the runner a synchronous check that tracks the live approval', async () => {
    const state = setup()
    const preview = state.preview()
    let isAuthorized: (() => boolean) | undefined
    state.runScript.mockImplementation(async (_run, check) => {
      isAuthorized = check
      expect(check()).toBe(true)
      state.setScript('echo changed')
      expect(check()).toBe(false)
      state.setScript('echo configured')
      state.setRepo(undefined)
      expect(check()).toBe(false)
      return { exitCode: 0, output: '' }
    })
    await state.service.decide(request(preview))
    expect(isAuthorized).toBeTypeOf('function')
  })

  it('reports stale, not execution-failed, when the runner refuses a revoked approval', async () => {
    const state = setup()
    const preview = state.preview()
    state.runScript.mockImplementation(async (_run, check) => {
      state.setScript('echo changed')
      if (!check()) {
        throw new Error('blocked before spawn')
      }
      return { exitCode: 0, output: '' }
    })
    expect(await state.service.decide(request(preview))).toEqual({ status: 'stale' })
    expect(state.service.getOutcome(preview)).toEqual({ status: 'stale' })
  })

  it('never invents an exit code and preserves upstream truncation', async () => {
    const state = setup()
    const preview = state.preview()
    state.runScript.mockResolvedValue({ output: 'timed out', outputTruncated: true })
    const result = await state.service.decide(request(preview))
    expect(result).toEqual({
      status: 'failed',
      output: 'timed out',
      outputTruncated: true
    })
    expect('exitCode' in result).toBe(false)
  })

  function catalogSetup() {
    const repos = new Map<string, Repo>()
    const runScript = vi.fn(async (): Promise<RepositoryAddScriptExecutionResult> => ({
      exitCode: 0,
      output: ''
    }))
    const service = new RepositoryAddScriptService({
      getOwner: () => ({ hostId: 'local', label: 'Local', available: true, supported: true }),
      getRepo: (id) => repos.get(id),
      repoExists: (id) => repos.has(id),
      getScript: () => 'echo configured',
      resolveTarget: nativeTarget,
      runScript
    })
    function offer(id: string) {
      const repo: Repo = { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1 }
      repos.set(id, repo)
      return service.offerForRegistration({ repo, disposition: 'new' })
    }
    return { repos, runScript, service, offer }
  }

  it('never evicts current pending approvals when retention capacity is exhausted', async () => {
    const state = catalogSetup()
    const first = state.offer('p-0')!
    for (let index = 1; index < 128; index++) {
      expect(state.offer(`p-${index}`)).not.toBeNull()
    }
    expect(state.offer('over-capacity')).toBeNull()
    expect(state.service.getOutcome(first)).toEqual({ status: 'pending' })
    expect(state.offer('p-0')).toEqual(first)
    expect(await state.service.decide(request(first))).toMatchObject({ status: 'succeeded' })
  })

  it('reclaims only stale pending approvals when capacity is exhausted', async () => {
    const state = catalogSetup()
    const previews: RepositoryAddScriptPreview[] = []
    for (let index = 0; index < 128; index++) {
      previews.push(state.offer(`p-${index}`)!)
    }
    state.repos.delete('p-5')
    expect(state.offer('next')).not.toBeNull()
    expect(state.service.getOutcome(previews[5])).toBeNull()
    expect(state.service.getOutcome(previews[6])).toEqual({ status: 'pending' })
    expect(state.offer('another')).toBeNull()
    expect(await state.service.decide(request(previews[6]))).toMatchObject({
      status: 'succeeded'
    })
  })

  it('never reclaims running claims even when their repo is removed', async () => {
    const state = catalogSetup()
    const completions: (() => void)[] = []
    state.runScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve({ exitCode: 0, output: '' }))
        })
    )
    const runs: Promise<RepositoryAddScriptDecisionResult>[] = []
    const offered: RepositoryAddScriptPreview[] = []
    for (let index = 0; index < 128; index++) {
      const preview = state.offer(`r-${index}`)!
      offered.push(preview)
      runs.push(state.service.decide(request(preview)))
    }
    state.repos.clear()
    expect(state.offer('next')).toBeNull()
    expect(state.service.getOutcome(offered[0])).toEqual({ status: 'running' })
    for (const complete of completions) {
      complete()
    }
    await Promise.all(runs)
  })
  it('retains an unverifiable run as its own outcome, not an ordinary failure', async () => {
    const state = setup()
    state.runScript.mockResolvedValue({
      processVerdict: 'unverifiable',
      output: 'partial\nmay still be running',
      outputTruncated: true
    })
    const preview = state.preview()
    const result = await state.service.decide(request(preview))
    expect(result).toEqual({
      status: 'unverifiable',
      output: 'partial\nmay still be running',
      outputTruncated: true
    })
    expect(state.service.getOutcome(preview)).toEqual(result)
    expect(await state.service.decide(request(preview))).toEqual({
      status: 'rejected',
      reason: 'used-token'
    })
  })

  it('an unverifiable verdict wins over any reported exit code', async () => {
    const state = setup()
    state.runScript.mockResolvedValue({ exitCode: 0, processVerdict: 'unverifiable', output: '' })
    const result = await state.service.decide(request(state.preview()))
    expect(result.status).toBe('unverifiable')
    expect('exitCode' in result).toBe(false)
  })

  it('never evicts or re-offers a possibly-live unverifiable run at the cap', async () => {
    const state = catalogSetup()
    state.runScript.mockResolvedValue({ processVerdict: 'unverifiable', output: '' })
    const offered: RepositoryAddScriptPreview[] = []
    for (let index = 0; index < 128; index++) {
      const preview = state.offer(`r-${index}`)!
      offered.push(preview)
      await state.service.decide(request(preview))
    }
    state.repos.clear()
    expect(state.offer('next')).toBeNull()
    expect(state.service.getOutcome(offered[0])?.status).toBe('unverifiable')
  })

  it('keeps the registration of an unverifiable run when the registration table is full', async () => {
    const repos = new Map<string, Repo>()
    const service = new RepositoryAddScriptService({
      getOwner: () => ({ hostId: 'local', label: 'Local', available: true, supported: true }),
      getRepo: (id) => repos.get(id),
      repoExists: (id) => repos.has(id),
      getScript: () => 'echo configured',
      resolveTarget: nativeTarget,
      runScript: vi.fn(async () => ({ processVerdict: 'unverifiable' as const, output: '' }))
    })
    const make = (id: string): Repo => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 1
    })
    const first = make('r-0')
    repos.set(first.id, first)
    const preview = service.offerForRegistration({ repo: first, disposition: 'new' })!
    await service.decide(request(preview))
    for (let index = 1; index < 4096; index++) {
      const repo = make(`r-${index}`)
      repos.set(repo.id, repo)
      service.revoke(service.offerForRegistration({ repo, disposition: 'new' })!.token)
    }
    repos.delete('r-0')
    const extra = make('extra')
    repos.set(extra.id, extra)
    expect(service.offerForRegistration({ repo: extra, disposition: 'new' })).toBeNull()
    expect(service.getOutcome(preview)?.status).toBe('unverifiable')
  })
})
