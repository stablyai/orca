import { describe, expect, it, vi } from 'vitest'
import { HostedEntitlementDeniedError } from './hosted-environment-provider'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { CANCEL_CLEANUP_UNCONFIRMED } from '../../shared/hosted-sandbox/cloud-workspace-api'
import {
  createCloudWorkspaceFromGitHub,
  githubWorkspaceId,
  retryCancelledGitHubCreate,
  type CreateFromGitHubClient
} from './cloud-create-from-github'

const READY = {
  sandbox: {
    id: 'sbx_1',
    workspaceId: 'web-00000000',
    status: 'running' as const,
    machineSize: 'standard' as const,
    region: 'iad1',
    session: null,
    createdAt: 1
  },
  connection: { type: 'orca-server' as const, pairingCode: 'code', projectRoot: '/work' }
}

function client(overrides: Partial<CreateFromGitHubClient> = {}): CreateFromGitHubClient {
  return {
    create: vi.fn(async () => READY),
    bootPlan: vi.fn(async () => 'clone' as const),
    cloneStatus: vi.fn(async () => ({ state: 'done' as const })),
    destroy: vi.fn(async (id: string) => ({ id, status: 'destroyed' as const })),
    list: vi.fn(async () => []),
    ...overrides
  }
}

const INPUT = {
  slug: 'acme/web',
  title: 'Fix login',
  provisionId: 'c-1234',
  idempotencyKey: 'create:c-1234'
}

describe('GitHub-only create on the build sheet (GH-CREATE-SHEET)', () => {
  it('reports the same steps as an owned create: start, boot plan, clone, connecting', async () => {
    const statuses = [
      { state: 'running' as const, percent: 40, stage: 'download' as const },
      { state: 'done' as const }
    ]
    const api = client({
      create: vi.fn(async () => ({ ...READY, clone: { state: 'running' as const } })),
      cloneStatus: vi.fn(async () => statuses.shift() ?? { state: 'done' as const })
    })
    const log: string[] = []
    const result = await createCloudWorkspaceFromGitHub(api, INPUT, {
      onLog: (chunk) => log.push(chunk)
    })
    expect(result).toEqual({ ok: true, value: { sandboxId: 'sbx_1' } })
    expect(log[0]).toBe('[orca-cloud] provisioning\n')
    expect(log).toContain('[orca-cloud] plan-clone\n')
    expect(log).toContain('[orca-cloud] cloning\n')
    expect(log).toContain('[orca-cloud] clone-progress 40 download\n')
    expect(log.at(-1)).toBe('[orca-cloud] connecting\n')
  })

  it('sends the key and a workspace id fixed per creation, so a Retry replays the same create', async () => {
    const api = client()
    await createCloudWorkspaceFromGitHub(api, INPUT)
    await createCloudWorkspaceFromGitHub(api, INPUT)
    const [first, second] = vi.mocked(api.create).mock.calls
    expect(first?.[0]).toEqual({
      workspaceId: githubWorkspaceId('acme/web', 'c-1234'),
      machineSize: 'standard',
      title: 'Fix login',
      repo: { url: 'https://github.com/acme/web.git' }
    })
    expect(first?.[2]).toBe('create:c-1234')
    // Same body both times: the server replays an Idempotency-Key only for the same request.
    expect(second?.[0]).toEqual(first?.[0])
    expect(githubWorkspaceId('acme/web', 'c-1234')).toMatch(/^web-[0-9a-f]{8}$/)
    expect(githubWorkspaceId('acme/web', 'c-5678')).not.toBe(
      githubWorkspaceId('acme/web', 'c-1234')
    )
  })

  it.each([
    ['no_subscription'],
    ['included_hours_exhausted'],
    ['overage_cap_reached'],
    ['payment_past_due']
  ])(
    'a billing refusal (%s) logs its reason line and comes back as cloudPlanRequired',
    async (reason) => {
      const api = client({
        create: vi.fn(async () => {
          throw new HostedEntitlementDeniedError('denied', reason)
        })
      })
      const log: string[] = []
      const result = await createCloudWorkspaceFromGitHub(api, INPUT, {
        onLog: (chunk) => log.push(chunk)
      })
      // The sheet classifies these exactly as an owned create's (one shared classifier).
      expect(log).toContain(`Orca Cloud: ${reason}\n`)
      expect(result).toMatchObject({
        ok: false,
        code: 'entitlement_denied',
        reason: 'cloudPlanRequired'
      })
    }
  )

  it('an unreachable control plane reads as unavailable', async () => {
    const api = client({
      create: vi.fn(async () => {
        throw new EnvironmentProviderError('unavailable', 'Orca Cloud is unreachable.')
      })
    })
    const result = await createCloudWorkspaceFromGitHub(api, INPUT)
    expect(result).toMatchObject({ ok: false, code: 'unavailable', reason: 'cloudUnavailable' })
  })

  it('a create that answers after Cancel deletes its sandbox instead of leaving it running', async () => {
    const controller = new AbortController()
    const api = client({
      create: vi.fn(async () => {
        controller.abort()
        return READY
      })
    })
    const result = await createCloudWorkspaceFromGitHub(api, INPUT, { signal: controller.signal })
    expect(result).toMatchObject({ ok: false })
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
  })
})

describe('EP-5: a cancel whose sandbox was not confirmed deleted', () => {
  it('answers reason cancelCleanupUnconfirmed (never a plain cancel), and Try again deletes it', async () => {
    const controller = new AbortController()
    let down = true
    const api = client({
      create: vi.fn(async (_body, signal) => {
        if (signal) {
          controller.abort()
          throw new EnvironmentProviderError('aborted', 'Cancelled.')
        }
        if (down) {
          throw new EnvironmentProviderError('unavailable', 'down')
        }
        return READY
      })
    })
    vi.useFakeTimers()
    let result: Awaited<ReturnType<typeof createCloudWorkspaceFromGitHub>>
    try {
      const pending = createCloudWorkspaceFromGitHub(api, INPUT, { signal: controller.signal })
      await vi.runAllTimersAsync()
      result = await pending
    } finally {
      vi.useRealTimers()
    }
    expect(result).toMatchObject({ ok: false, reason: CANCEL_CLEANUP_UNCONFIRMED })
    expect(api.destroy).not.toHaveBeenCalled()

    // Try again, once the control plane answers: the same body and key find the sandbox; it is deleted.
    down = false
    expect(
      await retryCancelledGitHubCreate(api, INPUT.provisionId, { waitMs: 0, log: () => {} })
    ).toBe(true)
    expect(api.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: githubWorkspaceId(INPUT.slug, INPUT.provisionId) }),
      undefined,
      INPUT.idempotencyKey
    )
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
    // Done: nothing left to retry.
    expect(await retryCancelledGitHubCreate(api, INPUT.provisionId)).toBe(true)
    expect(api.destroy).toHaveBeenCalledTimes(1)
  })
})
