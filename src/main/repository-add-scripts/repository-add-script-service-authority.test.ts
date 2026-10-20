import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type {
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptPreview,
  RepositoryAddScriptTarget
} from '../../shared/repository-add-script-types'
import {
  RepositoryAddScriptService,
  type RepositoryAddScriptOwner,
  type RepositoryAddScriptRun
} from './repository-add-script-service'

const ALIAS_A: ExecutionHostId = 'local'
const ALIAS_B: ExecutionHostId = 'runtime:env-1'

// One canonical catalog reachable through two host aliases, each projecting its own owner id.
function setup() {
  const repos = new Map<string, Repo>()
  const aliases = new Set<ExecutionHostId>([ALIAS_A, ALIAS_B])
  // Repos an alias's authority check rejects even though the canonical catalog still holds them.
  const refused = new Set<string>()
  let target: RepositoryAddScriptTarget | null | 'throws' = { kind: 'native', cwd: '/r' }
  let exists: boolean | 'throws' | undefined
  const getOwner = vi.fn((hostId: ExecutionHostId): RepositoryAddScriptOwner | null =>
    aliases.has(hostId) ? { hostId, label: hostId, available: true, supported: true } : null
  )
  const getRepo = vi.fn((id: string, hostId: ExecutionHostId) => {
    const repo = repos.get(id)
    return repo && aliases.has(hostId) && !refused.has(id)
      ? { ...repo, executionHostId: hostId }
      : undefined
  })
  const resolveTarget = vi.fn((_repo: Repo, _hostId: ExecutionHostId) => {
    if (target === 'throws') {
      throw new Error('runtime unavailable')
    }
    return target
  })
  const runScript = vi.fn(
    async (
      _run: RepositoryAddScriptRun,
      _isAuthorized: () => boolean,
      _signal: AbortSignal
    ): Promise<RepositoryAddScriptExecutionResult> => ({ exitCode: 0, output: '' })
  )
  const service = new RepositoryAddScriptService({
    getOwner,
    getRepo,
    repoExists: (id) => {
      if (exists === 'throws') {
        throw new Error('catalog unavailable')
      }
      return exists ?? repos.has(id)
    },
    getScript: () => 'echo configured',
    resolveTarget,
    runScript
  })
  function offer(id: string, hostId: ExecutionHostId = ALIAS_A) {
    const repo: Repo = repos.get(id) ?? {
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 1
    }
    repos.set(id, repo)
    return service.offerForRegistration({
      repo: { ...repo, executionHostId: hostId },
      disposition: 'new'
    })
  }
  return {
    service,
    repos,
    aliases,
    refused,
    getOwner,
    resolveTarget,
    runScript,
    offer,
    setTarget: (value: typeof target) => {
      target = value
    },
    setExists: (value: typeof exists) => {
      exists = value
    }
  }
}

function run(preview: RepositoryAddScriptPreview, decision: 'run' | 'skip' = 'run') {
  return { token: preview.token, hostId: preview.hostId, repoId: preview.repoId, decision }
}

describe('execution target binding', () => {
  it('binds the preview and the run to the resolved target', async () => {
    const state = setup()
    state.setTarget({ kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/r' })
    const preview = state.offer('r')!
    expect(preview.target).toEqual({ kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/r' })
    expect(state.resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }), ALIAS_A)
    await state.service.decide(run(preview))
    expect(state.runScript.mock.calls[0][0].target).toEqual(preview.target)
  })

  it.each<[string, RepositoryAddScriptTarget | null | 'throws']>([
    ['native to WSL', { kind: 'wsl', distro: 'Ubuntu', cwd: '/r' }],
    ['a different cwd', { kind: 'native', cwd: '/elsewhere' }],
    ['a repair-required or missing runtime', null],
    ['a resolver failure', 'throws']
  ])('marks approval stale on %s', async (_name, next) => {
    const state = setup()
    const preview = state.offer('r')!
    state.setTarget(next)
    expect(await state.service.decide(run(preview))).toEqual({ status: 'stale' })
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it.each<[string, RepositoryAddScriptTarget]>([
    ['WSL to native', { kind: 'native', cwd: '/r' }],
    ['distro A to B', { kind: 'wsl', distro: 'Debian', cwd: '/r' }]
  ])('marks a WSL approval stale on %s', async (_name, next) => {
    const state = setup()
    state.setTarget({ kind: 'wsl', distro: 'Ubuntu', cwd: '/r' })
    const preview = state.offer('r')!
    state.setTarget(next)
    expect(await state.service.decide(run(preview))).toEqual({ status: 'stale' })
    expect(state.runScript).not.toHaveBeenCalled()
  })

  it('refuses an invalid target at offer time', () => {
    const state = setup()
    state.setTarget({ kind: 'wsl', distro: '', cwd: '/r' })
    expect(state.offer('r')).toBeNull()
    state.setTarget(null)
    expect(state.offer('s')).toBeNull()
  })

  it('re-resolves the target in the pre-spawn check', async () => {
    const state = setup()
    const preview = state.offer('r')!
    state.runScript.mockImplementation(async (_run, check) => {
      expect(check()).toBe(true)
      state.setTarget({ kind: 'wsl', distro: 'Ubuntu', cwd: '/r' })
      expect(check()).toBe(false)
      throw new Error('blocked')
    })
    expect(await state.service.decide(run(preview))).toEqual({ status: 'stale' })
  })

  it('never shares nested target objects with callers, the resolver or the runner', async () => {
    const state = setup()
    const resolved: RepositoryAddScriptTarget = { kind: 'native', cwd: '/r' }
    state.setTarget(resolved)
    const preview = state.offer('r')!
    expect(preview.target).not.toBe(resolved)
    preview.target.cwd = '/forged'
    const again = state.offer('r')!
    expect(again.target).toEqual({ kind: 'native', cwd: '/r' })
    again.target.cwd = '/forged-again'
    state.setTarget({ kind: 'native', cwd: '/r' })
    state.runScript.mockImplementation(async (bound, check) => {
      bound.target.cwd = '/mutated-by-runner'
      expect(check()).toBe(true)
      return { exitCode: 0, output: '' }
    })
    expect(await state.service.decide(run(again))).toMatchObject({ status: 'succeeded' })
  })
})

describe('host aliases', () => {
  it('reads the owner alias from the trusted registration and requires an exact owner match', () => {
    const state = setup()
    expect(state.offer('r', ALIAS_B)?.hostId).toBe(ALIAS_B)
    expect(state.getOwner).toHaveBeenCalledWith(ALIAS_B)
    state.getOwner.mockImplementation((hostId) => ({
      hostId: hostId === ALIAS_A ? ALIAS_B : ALIAS_A,
      label: 'other',
      available: true,
      supported: true
    }))
    expect(state.offer('s', ALIAS_A)).toBeNull()
  })

  it('isolates aliases of one registration without staling or re-authorizing it', async () => {
    const state = setup()
    const first = state.offer('r', ALIAS_A)!
    expect(state.offer('r', ALIAS_B)).toBeNull()
    expect(state.service.getOutcome(first)).toEqual({ status: 'pending' })
    expect(await state.service.decide({ ...run(first), hostId: ALIAS_B })).toEqual({
      status: 'rejected',
      reason: 'identity-mismatch'
    })
    expect(state.service.getOutcome(first)).toEqual({ status: 'pending' })
    state.getOwner.mockClear()
    expect(await state.service.decide(run(first))).toMatchObject({ status: 'succeeded' })
    expect(state.getOwner.mock.calls.every(([hostId]) => hostId === ALIAS_A)).toBe(true)
    expect(state.offer('r', ALIAS_B)).toBeNull()
    expect(state.offer('r', ALIAS_A)).toBeNull()
    expect(state.runScript).toHaveBeenCalledTimes(1)
  })

  it('stales an approval when its own alias loses authority', async () => {
    const state = setup()
    const preview = state.offer('r', ALIAS_B)!
    state.aliases.delete(ALIAS_B)
    expect(await state.service.decide(run(preview))).toEqual({ status: 'stale' })
  })
})

describe('outcome lookup identity', () => {
  function identity(preview: RepositoryAddScriptPreview) {
    return { token: preview.token, hostId: preview.hostId, repoId: preview.repoId }
  }

  function expectOnlyOwnIdentity(
    state: ReturnType<typeof setup>,
    preview: RepositoryAddScriptPreview,
    expected: object
  ) {
    expect(state.service.getOutcome({ ...identity(preview), hostId: ALIAS_B })).toBeNull()
    expect(state.service.getOutcome({ ...identity(preview), repoId: 'other' })).toBeNull()
    expect(state.service.getOutcome({ ...identity(preview), token: 'unknown' })).toBeNull()
    const outcome = state.service.getOutcome(identity(preview))
    expect(outcome).toEqual(expected)
    expect(outcome).not.toBe(state.service.getOutcome(identity(preview)))
  }

  it('returns a pending outcome only to its own alias and repo', () => {
    const state = setup()
    expectOnlyOwnIdentity(state, state.offer('r')!, { status: 'pending' })
  })

  it('returns a running outcome only to its own alias and repo', async () => {
    const state = setup()
    let complete = (): void => {}
    state.runScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ exitCode: 0, output: '' })
        })
    )
    const preview = state.offer('r')!
    const decision = state.service.decide(run(preview))
    expectOnlyOwnIdentity(state, preview, { status: 'running' })
    complete()
    await decision
  })

  it('returns a terminal outcome only to its own alias and repo, as a fresh copy', async () => {
    const state = setup()
    state.runScript.mockResolvedValue({ exitCode: 0, output: 'done' })
    const preview = state.offer('r')!
    await state.service.decide(run(preview))
    const expected = { status: 'succeeded', exitCode: 0, output: 'done', outputTruncated: false }
    expectOnlyOwnIdentity(state, preview, expected)
    const outcome = state.service.getOutcome(identity(preview))
    if (outcome && 'output' in outcome) {
      outcome.output = 'mutated'
    }
    expect(state.service.getOutcome(identity(preview))).toEqual(expected)
  })

  it('fails closed on a missing or malformed identity', () => {
    const state = setup()
    const preview = state.offer('r')!
    // @ts-expect-error A missing identity must fail closed at runtime.
    expect(state.service.getOutcome(null)).toBeNull()
    // @ts-expect-error A token-only lookup must fail closed at runtime.
    expect(state.service.getOutcome({ token: preview.token })).toBeNull()
  })
})

describe('registration record pruning', () => {
  function fill(state: ReturnType<typeof setup>) {
    for (let index = 0; index < 4096; index++) {
      state.service.revoke(state.offer(`r-${index}`)!.token)
    }
  }

  it('keeps records when an alias merely refuses the repo, and prunes only actual absence', () => {
    const state = setup()
    fill(state)
    for (let index = 0; index < 4096; index++) {
      state.refused.add(`r-${index}`)
    }
    expect(state.offer('extra')).toBeNull()
    state.setExists('throws')
    expect(state.offer('extra')).toBeNull()
    state.setExists(undefined)
    state.refused.clear()
    // The record survived, so the same UUID is never offered again.
    expect(state.offer('r-0')).toBeNull()
    state.repos.delete('r-0')
    expect(state.offer('extra')).not.toBeNull()
  })
})
