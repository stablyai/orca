import { describe, expect, it, vi } from 'vitest'
import { MaestroBrowserSurfaceReceiptSchema } from '../../../../shared/maestro-browser-surface'
import type { MaestroPrincipal } from '../../../../shared/maestro-actor'
import { browserSurfaceReceipt } from '../../../../shared/maestro-browser-surface.test'
import {
  ensureMaestroBrowserSurface,
  ORCHESTRATION_BROWSER_SURFACE_METHODS
} from './orchestration-browser-surface'
import {
  requireBrowserSurfaceActionAuthority,
  requireBrowserSurfaceCreateAuthority
} from './orchestration-browser-surface-authority'

// The runtime reports the raw worktree id; the Maestro anchor carries the prefixed workspace key.
const WORKTREE_ID = 'repo-1::/repos/orca-wt'
const WORKSPACE_KEY = `worktree:${WORKTREE_ID}`
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-browser-surface-test' },
  nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 1920, height: 1080 }) }) }
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined)
}))

const resolveMaestroPrincipalMock = vi.hoisted(() =>
  vi.fn(
    async (
      _context: unknown,
      workspace: MaestroPrincipal['workspace']
    ): Promise<MaestroPrincipal> => ({
      actor_id: 'coordinator-1',
      kind: 'coordinator' as const,
      authenticated: true as const,
      session_id: 'session-1',
      workspace,
      generation: 1
    })
  )
)

vi.mock('../maestro-principal', () => ({
  resolveMaestroPrincipal: resolveMaestroPrincipalMock
}))

/** A surface that settled unavailable because its paint was never observed. */
function unobservedSurfaceReceipt() {
  return {
    ...browserSurfaceReceipt(),
    workspace_key: WORKSPACE_KEY,
    state: 'unavailable',
    observed_visibility: 'unverifiable',
    evidence_receipt: null,
    focus_receipt: {
      requested: true,
      workspace_activated: true,
      exact_page_selected: false,
      native_pane_paint: 'unobserved',
      observed_at: null,
      unavailable_reason: 'The exact native Browser pane has not been observed for paint yet.'
    }
  }
}

function actionRequest(surfaceId: string) {
  return {
    schema_version: 1 as const,
    protocol: 'maestro-browser-surface/v1' as const,
    workspace: {
      repository_id: 'repo-1',
      execution_host_id: 'local',
      workspace_key: WORKSPACE_KEY,
      run_id: 'run-1'
    },
    actor: {
      actor_id: 'forged',
      kind: 'user' as const,
      authenticated: true as const,
      session_id: 'forged'
    },
    coordinator_generation: 1,
    surface_id: surfaceId
  }
}

function profileConsentReceipt(options: { revokedAt?: string | null; expiresAt?: string } = {}) {
  return {
    schema_version: 1 as const,
    protocol: 'maestro-browser-profile-consent/v1' as const,
    consent_id: 'consent-1',
    profile_id: 'profile-1',
    run_id: 'run-1',
    task_id: 'task-1',
    attempt_id: 'dispatch-1',
    granted_by: {
      actor_id: 'human-1',
      kind: 'user' as const,
      authenticated: true as const,
      session_id: 'human-session-1'
    },
    granted_at: '2026-08-31T20:00:00.000Z',
    expires_at: options.expiresAt ?? '2099-08-31T20:00:00.000Z',
    revoked_at: options.revokedAt ?? null
  }
}

function profileSurfaceReceipt() {
  return {
    ...browserSurfaceReceipt(),
    workspace_key: WORKSPACE_KEY,
    task_id: 'task-1',
    attempt_id: 'dispatch-1',
    profile_id: 'profile-1'
  }
}

function method(name: string) {
  const found = ORCHESTRATION_BROWSER_SURFACE_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing browser surface RPC method: ${name}`)
  }
  return found
}

describe('orchestration browser surface RPC', () => {
  it('lets only an authenticated human issue and revoke exact profile consent', async () => {
    const grantMaestroBrowserProfileConsent = vi.fn().mockReturnValue(profileConsentReceipt())
    const revokeMaestroBrowserProfileConsent = vi
      .fn()
      .mockReturnValue(profileConsentReceipt({ revokedAt: '2026-08-31T21:00:00.000Z' }))
    const database = {
      getTask: () => ({ run_id: 'run-1' }),
      getDispatchContextById: () => ({
        id: 'dispatch-1',
        run_id: 'run-1',
        task_id: 'task-1',
        status: 'dispatched'
      }),
      grantMaestroBrowserProfileConsent,
      revokeMaestroBrowserProfileConsent
    }
    const grantRequest = {
      schema_version: 1 as const,
      protocol: 'maestro-browser-profile-consent/v1' as const,
      workspace: actionRequest('unused').workspace,
      profile_id: 'profile-1',
      task_id: 'task-1',
      attempt_id: 'dispatch-1',
      expires_at: '2099-08-31T20:00:00.000Z'
    }
    const context = { runtime: { getOrchestrationDb: () => database } } as never

    await expect(
      method('orchestration.browserProfileConsent.grant').handler(grantRequest, context)
    ).rejects.toThrow('authenticated human')
    expect(grantMaestroBrowserProfileConsent).not.toHaveBeenCalled()

    resolveMaestroPrincipalMock.mockResolvedValueOnce({
      actor_id: 'human-1',
      kind: 'user',
      authenticated: true,
      session_id: 'human-session-1',
      workspace: grantRequest.workspace
    })
    await expect(
      method('orchestration.browserProfileConsent.grant').handler(grantRequest, context)
    ).resolves.toMatchObject({ consent_id: 'consent-1', granted_by: { kind: 'user' } })

    resolveMaestroPrincipalMock.mockResolvedValueOnce({
      actor_id: 'human-1',
      kind: 'user',
      authenticated: true,
      session_id: 'human-session-1',
      workspace: grantRequest.workspace
    })
    await expect(
      method('orchestration.browserProfileConsent.revoke').handler(
        {
          schema_version: 1,
          protocol: 'maestro-browser-profile-consent/v1',
          workspace: grantRequest.workspace,
          consent_id: 'consent-1'
        },
        context
      )
    ).resolves.toMatchObject({ revoked_at: '2026-08-31T21:00:00.000Z' })
  })

  it('rejects a syntactically valid profile receipt not issued by the host before Browser effects', async () => {
    const receipt = { ...profileSurfaceReceipt(), state: 'reserved' as const }
    const browserTabShow = vi.fn().mockResolvedValue({
      tab: {
        browserPageId: receipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: receipt.profile_id,
        active: false
      }
    })
    const browserScreenshot = vi.fn().mockResolvedValue({ data: TEST_PNG_BASE64, format: 'png' })
    const database = {
      getMaestroBrowserProfileConsent: () => undefined,
      reserveMaestroBrowserSurface: () => ({ receipt }),
      updateMaestroBrowserSurface: (
        _surfaceId: string,
        update: (current: typeof receipt) => typeof receipt
      ) => ({ receipt: update(receipt) })
    }
    const request = {
      ...actionRequest(receipt.surface_id),
      request_id: 'request-profile-1',
      task_id: 'task-1',
      attempt_id: 'dispatch-1',
      agent_id: 'opencode',
      url: 'https://example.com/profile',
      title: 'Authenticated research',
      profile_id: 'profile-1',
      profile_consent_receipt: profileConsentReceipt(),
      requested_visibility: 'offscreen',
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      retention: 'release_when_settled',
      ownership: 'harness',
      evidence: {
        route_or_component: 'Authenticated research',
        state: 'open',
        theme: 'dark',
        source_revision: 'revision-1',
        capture_mode: 'native-viewport'
      }
    } as const
    let rejection: unknown

    try {
      await method('orchestration.browserSurface.ensure').handler(request, {
        runtime: {
          getOrchestrationDb: () => database,
          browserTabShow,
          browserScreenshot
        }
      } as never)
    } catch (error) {
      rejection = error
    }

    expect.soft(rejection).toBeInstanceOf(Error)
    expect.soft(browserTabShow).not.toHaveBeenCalled()
    expect.soft(browserScreenshot).not.toHaveBeenCalled()
  })

  it('keeps release available after profile consent becomes inactive without allowing new actions', async () => {
    const inactiveReceipts = [
      profileConsentReceipt({ revokedAt: '2026-08-31T21:00:00.000Z' }),
      profileConsentReceipt({ expiresAt: '2026-08-31T19:00:00.000Z' })
    ]

    for (const consent of inactiveReceipts) {
      let currentReceipt = profileSurfaceReceipt()
      const browserTabShow = vi.fn().mockImplementation(async () => ({
        tab: {
          browserPageId: currentReceipt.browser_page_id,
          worktreeId: WORKTREE_ID,
          profileId: currentReceipt.profile_id,
          active: true
        }
      }))
      const browserTabClose = vi.fn().mockResolvedValue(undefined)
      const database = {
        getMaestroBrowserProfileConsent: () => consent,
        getMaestroBrowserSurface: () => ({ receipt: currentReceipt }),
        updateMaestroBrowserSurface: (
          _surfaceId: string,
          update: (receipt: typeof currentReceipt) => typeof currentReceipt
        ) => {
          currentReceipt = update(currentReceipt)
          return { receipt: currentReceipt }
        }
      }
      const runtime = {
        getOrchestrationDb: () => database,
        activateManagedWorktree: vi.fn(),
        browserTabSwitch: vi.fn(),
        browserTabShow,
        browserTabClose
      }
      const request = {
        ...actionRequest(currentReceipt.surface_id),
        profile_consent_receipt: consent
      }

      await expect(
        method('orchestration.browserSurface.focus').handler(request, { runtime } as never)
      ).rejects.toThrow()
      await expect(
        method('orchestration.browserSurface.release').handler(
          { ...request, request_id: `release-${consent.consent_id}`, reason: 'Review complete' },
          { runtime } as never
        )
      ).resolves.toMatchObject({ state: 'released' })
      expect(browserTabClose).toHaveBeenCalledOnce()
    }
  })

  it('lets an active worker own a managed surface only for its exact Task and Dispatch', () => {
    const worker = {
      actor_id: 'term-worker-1',
      kind: 'worker' as const,
      authenticated: true as const,
      session_id: 'process-1',
      workspace: {
        execution_host_id: 'local',
        workspace_key: WORKSPACE_KEY,
        run_id: 'run-1'
      }
    }
    const receipt = {
      ...browserSurfaceReceipt(),
      workspace_key: WORKSPACE_KEY,
      owner_principal: worker.actor_id,
      task_id: 'task-1',
      attempt_id: 'dispatch-1'
    }
    const database = {
      getRun: () => ({ consumer_generation: 1 }),
      getActiveDispatchForIdentity: () => ({
        id: 'dispatch-1',
        run_id: 'run-1',
        task_id: 'task-1'
      }),
      getMaestroBrowserSurface: () => ({ receipt })
    }
    const context = { runtime: { getOrchestrationDb: () => database } } as never
    const createRequest = {
      ...actionRequest(receipt.surface_id),
      request_id: 'request-1',
      task_id: 'task-1',
      attempt_id: 'dispatch-1',
      agent_id: 'opencode',
      url: 'https://example.com',
      title: 'Research',
      profile_id: null,
      requested_visibility: 'visible',
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      retention: 'release_when_settled',
      ownership: 'harness',
      evidence: {
        route_or_component: 'Research',
        state: 'open',
        theme: 'dark',
        source_revision: 'revision-1',
        capture_mode: 'native-viewport'
      }
    } as const

    expect(() => requireBrowserSurfaceCreateAuthority(worker, createRequest, context)).not.toThrow()
    expect(() =>
      requireBrowserSurfaceActionAuthority(worker, actionRequest(receipt.surface_id), context)
    ).not.toThrow()
    expect(() =>
      requireBrowserSurfaceCreateAuthority(
        worker,
        { ...createRequest, attempt_id: 'dispatch-2' },
        context
      )
    ).toThrow('exact Task and Dispatch')
  })

  it('selects and identifies the exact page by worktree id, not by workspace key', async () => {
    // Regression: `id:${workspace_key}` emitted `id:worktree:<id>`, which resolved to nothing, and
    // the identity gate compared the tab's raw worktree id against the prefixed workspace key,
    // which can never match.
    const receipt = { ...browserSurfaceReceipt(), workspace_key: WORKSPACE_KEY }
    const activateManagedWorktree = vi.fn().mockResolvedValue({ activated: true })
    const browserTabSwitch = vi.fn().mockResolvedValue({ browserPageId: receipt.browser_page_id })
    const browserTabShow = vi.fn().mockResolvedValue({
      tab: {
        browserPageId: receipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: receipt.profile_id,
        active: true
      }
    })
    const updateMaestroBrowserSurface = vi.fn(
      (_surfaceId: string, update: (current: typeof receipt) => typeof receipt) => ({
        receipt: update(receipt)
      })
    )
    const runtime = {
      getOrchestrationDb: () => ({
        getMaestroBrowserSurface: () => ({ receipt }),
        updateMaestroBrowserSurface
      }),
      activateManagedWorktree,
      browserTabSwitch,
      browserTabShow
    }
    const request = {
      schema_version: 1 as const,
      protocol: 'maestro-browser-surface/v1' as const,
      workspace: {
        repository_id: 'repo-1',
        execution_host_id: 'local',
        workspace_key: WORKSPACE_KEY,
        run_id: 'run-1'
      },
      actor: {
        actor_id: 'forged',
        kind: 'user' as const,
        authenticated: true,
        session_id: 'forged'
      },
      coordinator_generation: 1,
      surface_id: receipt.surface_id
    }

    const result = await method('orchestration.browserSurface.focus').handler(request, {
      runtime
    } as never)

    expect(activateManagedWorktree).toHaveBeenCalledWith(`id:${WORKTREE_ID}`, {
      navigation: 'host'
    })
    expect(browserTabSwitch).toHaveBeenCalledWith({
      page: 'maestro-request-1',
      worktree: `id:${WORKTREE_ID}`,
      focus: true
    })
    expect(browserTabShow).toHaveBeenCalledWith({
      page: 'maestro-request-1',
      worktree: `id:${WORKTREE_ID}`
    })
    expect(result).toMatchObject({
      requested_visibility: 'visible',
      observed_visibility: 'visible',
      focus_receipt: { exact_page_selected: true, native_pane_paint: 'painted' }
    })
  })

  it('passes the ensure identity gate when the tab reports its raw worktree id', async () => {
    const receipt = { ...browserSurfaceReceipt(), workspace_key: WORKSPACE_KEY, state: 'reserved' }
    const browserTabShow = vi.fn().mockResolvedValue({
      tab: {
        browserPageId: receipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: receipt.profile_id,
        active: true
      }
    })
    const runtime = {
      getOrchestrationDb: () => ({
        reserveMaestroBrowserSurface: () => ({ receipt }),
        updateMaestroBrowserSurface: (
          _surfaceId: string,
          update: (current: typeof receipt) => typeof receipt
        ) => ({ receipt: update(receipt) })
      }),
      activateManagedWorktree: vi.fn().mockResolvedValue({ activated: true }),
      browserTabSwitch: vi.fn().mockResolvedValue({ browserPageId: receipt.browser_page_id }),
      browserTabShow
    }
    const request = {
      workspace: { workspace_key: WORKSPACE_KEY },
      ownership: 'harness',
      requested_visibility: 'visible',
      profile_id: receipt.profile_id
    }

    // No paint evidence, so this settles as unavailable — reaching that verdict at all proves the
    // identity gate accepted the raw worktree id instead of throwing identity_mismatch.
    const result = await ensureMaestroBrowserSurface(request as never, { runtime } as never)

    expect(browserTabShow).toHaveBeenCalledWith({
      page: receipt.browser_page_id,
      worktree: `id:${WORKTREE_ID}`
    })
    expect(result).toMatchObject({ state: 'unavailable', observed_visibility: 'unverifiable' })
  })

  it('reports exact safe Browser binding differences before taking an action', async () => {
    const receipt = { ...browserSurfaceReceipt(), workspace_key: WORKSPACE_KEY, state: 'reserved' }
    const runtime = {
      getOrchestrationDb: () => ({
        reserveMaestroBrowserSurface: () => ({ receipt }),
        updateMaestroBrowserSurface: (
          _surfaceId: string,
          update: (current: typeof receipt) => typeof receipt
        ) => ({ receipt: update(receipt) })
      }),
      browserTabShow: vi.fn().mockResolvedValue({
        tab: {
          browserPageId: 'page-observed',
          worktreeId: 'repo-other::/workspace',
          profileId: 'profile-observed',
          active: false
        }
      })
    }
    let rejection: unknown

    try {
      await ensureMaestroBrowserSurface(
        {
          workspace: { workspace_key: WORKSPACE_KEY },
          ownership: 'harness',
          requested_visibility: 'offscreen',
          profile_id: receipt.profile_id
        } as never,
        { runtime } as never
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({
      code: 'browser_surface_identity_mismatch',
      data: {
        expected: { browserPageId: receipt.browser_page_id, worktreeId: WORKTREE_ID },
        observed: {
          browserPageId: 'page-observed',
          worktreeId: 'repo-other::/workspace',
          profileId: 'profile-observed'
        },
        differences: ['browserPageId', 'worktreeId', 'profileId']
      }
    })
  })

  it('upgrades an unobserved paint verdict when focus genuinely observes the pane', async () => {
    const unobservedReceipt = unobservedSurfaceReceipt()
    const browserTabShow = vi.fn().mockResolvedValue({
      tab: {
        browserPageId: unobservedReceipt.browser_page_id,
        worktreeId: WORKTREE_ID,
        profileId: unobservedReceipt.profile_id,
        active: true
      }
    })
    const runtime = {
      getOrchestrationDb: () => ({
        getMaestroBrowserSurface: () => ({ receipt: unobservedReceipt }),
        updateMaestroBrowserSurface: (
          _surfaceId: string,
          update: (current: typeof unobservedReceipt) => typeof unobservedReceipt
        ) => ({ receipt: update(unobservedReceipt) })
      }),
      activateManagedWorktree: vi.fn().mockResolvedValue({ activated: true }),
      browserTabSwitch: vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: unobservedReceipt.browser_page_id,
        focusReceipt: {
          requested: true,
          exactPageSelected: true,
          nativePanePaint: 'painted',
          observedAt: '2026-08-25T12:00:00.000Z'
        }
      }),
      browserTabShow
    }

    const result = await method('orchestration.browserSurface.focus').handler(
      actionRequest(unobservedReceipt.surface_id),
      { runtime } as never
    )

    expect(result).toMatchObject({
      observed_visibility: 'visible',
      focus_receipt: {
        native_pane_paint: 'painted',
        observed_at: '2026-08-25T12:00:00.000Z',
        unavailable_reason: null
      }
    })
  })

  it('recovers an unavailable surface from a successful native capture and keeps its retention', async () => {
    const unobservedReceipt = unobservedSurfaceReceipt()
    const capturingRuntime = (receipt: typeof unobservedReceipt) => ({
      getOrchestrationDb: () => ({
        getMaestroBrowserSurface: () => ({ receipt }),
        updateMaestroBrowserSurface: (
          _surfaceId: string,
          update: (current: typeof receipt) => typeof receipt
        ) => ({ receipt: update(receipt) })
      }),
      browserTabShow: vi.fn().mockResolvedValue({
        tab: {
          browserPageId: receipt.browser_page_id,
          worktreeId: WORKTREE_ID,
          profileId: receipt.profile_id,
          active: true
        }
      }),
      browserScreenshot: vi.fn().mockResolvedValue({ data: TEST_PNG_BASE64, format: 'png' })
    })

    // Parsing narrows the handler's `unknown` honestly, and proves the recovered receipt is valid.
    const result = MaestroBrowserSurfaceReceiptSchema.parse(
      await method('orchestration.browserSurface.capture').handler(
        actionRequest(unobservedReceipt.surface_id),
        { runtime: capturingRuntime(unobservedReceipt) } as never
      )
    )

    expect(result).toMatchObject({
      state: 'active',
      observed_visibility: 'visible',
      focus_receipt: {
        exact_page_selected: true,
        native_pane_paint: 'painted',
        unavailable_reason: null
      },
      evidence_receipt: {
        protocol: 'maestro-browser-evidence/v1',
        format: 'png',
        route_or_component: 'Maestro browser surface',
        capture_mode: 'native-viewport',
        dimensions: { width: 1920, height: 1080 }
      }
    })
    expect(result.focus_receipt.observed_at).toEqual(expect.any(String))

    const retained = await method('orchestration.browserSurface.capture').handler(
      actionRequest(unobservedReceipt.surface_id),
      { runtime: capturingRuntime({ ...unobservedReceipt, retention: 'retain' }) } as never
    )

    expect(retained).toMatchObject({ state: 'retained' })
  })
})
