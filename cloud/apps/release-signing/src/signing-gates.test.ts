import { afterEach, describe, expect, it, vi } from 'vitest'
import { SigningGates } from './signing-gates.js'
import { ApiError } from './github-app.js'
import type { SigningConfig } from './config.js'

export const config: SigningConfig = {
  repository: 'stablyai/orca',
  appId: '12',
  installationId: 34,
  privateKey: 'unused',
  githubWebhookSecret: 'github-secret'.repeat(4),
  signpathWebhookSecret: 'signpath-secret'.repeat(4),
  reconcileSecret: 'reconcile-secret'.repeat(4),
  signpathToken: 'unused',
  signpathOrganization: '11111111-1111-4111-8111-111111111111',
  signpathProject: 'orca',
  policies: [
    {
      workflow: '.github/workflows/release-cut.yml',
      branch: 'main',
      signingPolicy: 'release-signing',
      environments: {
        inner: 'windows-inner-signing',
        installer: 'windows-installer-signing'
      }
    }
  ]
}
const requestId = '22222222-2222-4222-8222-222222222222'
const sha = 'a'.repeat(40)
function fixture() {
  const run = {
    id: 42,
    run_attempt: 1,
    path: config.policies[0]!.workflow,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha,
    repository: { full_name: String(config.repository) },
    head_repository: { full_name: String(config.repository) }
  }
  const artifact = {
    id: 10,
    name: `orca-signing-inner-42-1-${requestId}`,
    expired: false,
    workflow_run: { id: 42, head_sha: sha }
  }
  const request = {
    status: 'Completed',
    isFinalStatus: true,
    projectSlug: 'orca',
    signingPolicySlug: 'release-signing',
    artifactConfigurationSlug: 'windows-inner-binaries-zip',
    origin: {
      buildData: { url: 'https://github.com/stablyai/orca/actions/runs/42' },
      repositoryData: {
        url: 'https://github.com/stablyai/orca',
        commitId: sha
      }
    }
  }
  const pending = [{ environment: { name: 'windows-inner-signing' } }]
  const github = vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
    if (body) return null
    if (path.endsWith('/pending_deployments')) return pending
    if (path.includes('/artifacts?')) return { total_count: 1, artifacts: [artifact] }
    if (path.endsWith('/deployment_protection_rules'))
      return {
        custom_deployment_protection_rules: [{ enabled: true, app: { id: 12 } }]
      }
    if (path.includes('/environments/')) return { can_admins_bypass: false }
    if (path.includes('/actions/workflows/'))
      return { total_count: 2, workflow_runs: [{ id: 41 }, { id: 42 }] }
    if (path.endsWith('/41')) throw new Error('Broken old run')
    return structuredClone(run)
  })
  const signpath = vi.fn(async () => structuredClone(request))
  const gates = new SigningGates(config, { github, signpath })
  const reviews = () => github.mock.calls.filter(([, body]) => body !== undefined)
  return { gates, github, signpath, run, artifact, request, pending, reviews }
}
afterEach(() => vi.useRealTimers())
describe('signing authority', () => {
  it('approves a completed same-run request and original checkpoint on a rerun', async () => {
    const f = fixture()
    f.run.run_attempt = 2
    await f.gates.processRun(42)
    expect(f.reviews()).toEqual([
      [
        expect.stringContaining('/42/deployment_protection_rule'),
        expect.objectContaining({
          state: 'approved',
          environment_name: 'windows-inner-signing'
        })
      ]
    ])
  })
  it.each(['Failed', 'Denied', 'Canceled'])('rejects terminal %s', async (status) => {
    const f = fixture()
    f.request.status = status
    await f.gates.processRun(42)
    expect(f.reviews()[0]?.[1]).toMatchObject({ state: 'rejected' })
  })
  it.each(['WaitingForApproval', 'InProgress'])(
    'leaves %s waiting without review',
    async (status) => {
      const f = fixture()
      f.request.status = status
      f.request.isFinalStatus = false
      await f.gates.processRun(42)
      expect(f.reviews()).toHaveLength(0)
    }
  )
  it.each([
    'policy',
    'commit',
    'run',
    'repository',
    'configuration',
    'expired',
    'artifact-sha',
    'workflow',
    'branch',
    'fork'
  ])('refuses mismatched %s', async (mismatch) => {
    const f = fixture()
    if (mismatch === 'policy') f.request.signingPolicySlug = 'test-signing'
    if (mismatch === 'commit') f.request.origin.repositoryData.commitId = 'b'.repeat(40)
    if (mismatch === 'run') f.request.origin.buildData.url += '9'
    if (mismatch === 'repository') f.request.origin.repositoryData.url += '-evil'
    if (mismatch === 'configuration') f.request.artifactConfigurationSlug = 'other'
    if (mismatch === 'expired') f.artifact.expired = true
    if (mismatch === 'artifact-sha') f.artifact.workflow_run.head_sha = 'b'.repeat(40)
    if (mismatch === 'workflow') f.run.path = '.github/workflows/other.yml'
    if (mismatch === 'branch') f.run.head_branch = 'other'
    if (mismatch === 'fork') f.run.head_repository.full_name = 'evil/orca'
    await expect(f.gates.processRun(42)).rejects.toThrow()
    expect(f.reviews()).toHaveLength(0)
  })
  it('handles completion before the environment exists, then approves its later event', async () => {
    const f = fixture()
    f.pending.length = 0
    await f.gates.processSignpath(requestId)
    expect(f.reviews()).toHaveLength(0)
    f.pending.push({ environment: { name: 'windows-inner-signing' } })
    await f.gates.processRun(42, 'windows-inner-signing')
    expect(f.reviews()).toHaveLength(1)
  })
  it('refuses attempt movement during SignPath verification', async () => {
    const f = fixture()
    f.signpath.mockImplementation(async () => {
      f.run.run_attempt++
      return f.request
    })
    await expect(f.gates.processRun(42)).rejects.toThrow('attempt changed')
    expect(f.reviews()).toHaveLength(0)
  })
  it('ignores duplicate-review conflict only after the pending environment disappears', async () => {
    const f = fixture()
    const original = f.github.getMockImplementation()!
    f.github.mockImplementation(async (path, body) => {
      if (body) {
        f.pending.length = 0
        throw new ApiError(422, path)
      }
      return original(path, body)
    })
    await expect(f.gates.processRun(42)).resolves.toBeUndefined()
  })
  it('does not swallow a rejected review while its environment remains pending', async () => {
    const f = fixture()
    const original = f.github.getMockImplementation()!
    f.github.mockImplementation(async (path, body) => {
      if (body) throw new ApiError(422, path)
      return original(path, body)
    })
    await expect(f.gates.processRun(42)).rejects.toBeInstanceOf(ApiError)
  })
})
describe('recovery and readiness', () => {
  it('continues past a broken run and reports an aggregate failure afterwards', async () => {
    const f = fixture()
    await expect(f.gates.reconcile()).rejects.toBeInstanceOf(AggregateError)
    expect(f.reviews()).toHaveLength(1)
  })
  it('shares and caches readiness checks for 30 seconds', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await Promise.all(Array.from({ length: 20 }, () => f.gates.checkConfiguration()))
    expect(f.github).toHaveBeenCalledTimes(4)
    await f.gates.checkConfiguration()
    expect(f.github).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(30_000)
    await f.gates.checkConfiguration()
    expect(f.github).toHaveBeenCalledTimes(8)
  })
  it('caches failure briefly and retries without falsely reporting ready', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.github.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(f.gates.checkConfiguration()).rejects.toThrow('Unavailable')
    await expect(f.gates.checkConfiguration()).rejects.toThrow('Unavailable')
    expect(f.github).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    await expect(f.gates.checkConfiguration()).resolves.toBeUndefined()
  })
  it('requires disabled administrator bypass and the matching enabled app', async () => {
    const f = fixture()
    f.github.mockResolvedValueOnce({ can_admins_bypass: true })
    await expect(f.gates.checkConfiguration()).rejects.toThrow()
    const g = fixture()
    g.github.mockResolvedValueOnce({ can_admins_bypass: false }).mockResolvedValueOnce({
      custom_deployment_protection_rules: [{ enabled: true, app: { id: 99 } }]
    })
    await expect(g.gates.checkConfiguration()).rejects.toThrow('protection is missing')
  })
})
